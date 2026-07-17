// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp MCP — Baileys puro (sem Evolution API, sem Postgres, sem Redis).
// Rodando numa VM Compute Engine e2-micro sempre ligada (Always Free tier),
// porque a sessão WhatsApp Web exige WebSocket persistente — incompatível com
// Cloud Run/serverless (ver docs/estudo-viabilidade-mcp-whatsapp.md).
//
// Ferramentas:
//   • enviar_mensagem_whatsapp(texto) — envia E confirma a entrega (recibo). O
//     destinatário é FIXO (env WHATSAPP_DESTINO), não é parâmetro — evita o modelo
//     mandar pro número errado.
//   • verificar_status_envio(id) — reconfere a entrega de um envio anterior.
//   • verificar_status_conexao() — observabilidade: o canal está online?
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import { spawn } from 'node:child_process';
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from '@whiskeysockets/baileys';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const PORT = parseInt(process.env.PORT ?? '8080', 10);
const MCP_API_KEY = process.env.MCP_API_KEY;
const WHATSAPP_DESTINO = process.env.WHATSAPP_DESTINO; // ex: 5511999999999@s.whatsapp.net
const AUTH_DIR = process.env.AUTH_DIR ?? './auth_info_baileys';

if (!MCP_API_KEY) throw new Error('MCP_API_KEY não configurada.');
if (!WHATSAPP_DESTINO) throw new Error('WHATSAPP_DESTINO não configurada (ex: 5511999999999@s.whatsapp.net).');

const logger = pino({ level: process.env.LOG_LEVEL ?? 'warn' });

// ── Sessão Baileys — SINGLETON no escopo do módulo (a sessão é 1 conexão global,
// diferente do padrão "servidor novo por request" do MCP em si). Reconexão
// explícita: o Baileys não reconecta sozinho desde a v6 — precisa ouvir
// connection.update e decidir com base no DisconnectReason. ─────────────────
let sock = null;
let connectionStatus = 'iniciando';
let reconnecting = false; // impede reconexões sobrepostas (martelo → 405)
const RECONNECT_DELAY_MS = 5000;
const ACK_WAIT_MS = 7000;  // quanto o envio espera pelo recibo de entrega antes de responder

// ── Observabilidade + confirmação de entrega ────────────────────────────────
// O WhatsApp emite recibos por mensagem (enviado→entregue→lido). O Baileys expõe
// isso em 'messages.update' com update.status numérico (enum WebMessageInfo.Status).
// Rastreamos o status de cada envio para o orquestrador saber se o alerta CHEGOU.
const startedAt = Date.now();
let conectadoDesde = null;
let ultimaEntregaOkAt = null;

const STATUS_LABEL = { 0: 'erro', 1: 'pendente', 2: 'enviado_ao_servidor', 3: 'entregue', 4: 'lido', 5: 'reproduzido' };
const MAX_TRACK = 300;
const enviosStatus = new Map(); // id -> { statusNum, status, at, preview, jid }
const ackWaiters = new Map();   // id -> [cb,...] chamados quando entregue/lido

function registrarStatus(id, statusNum, extra = {}) {
  if (!id) return;
  const prev = enviosStatus.get(id) ?? {};
  const finalNum = Math.max(prev.statusNum ?? 0, statusNum); // nunca regride (entregue não volta a pendente)
  enviosStatus.set(id, { ...prev, ...extra, statusNum: finalNum, status: STATUS_LABEL[finalNum] ?? `desconhecido(${finalNum})`, at: Date.now() });
  if (enviosStatus.size > MAX_TRACK) enviosStatus.delete(enviosStatus.keys().next().value); // buffer dos últimos N
  if (finalNum >= 3) {
    ultimaEntregaOkAt = Date.now();
    const cbs = ackWaiters.get(id);
    if (cbs) { cbs.forEach((cb) => cb()); ackWaiters.delete(id); }
  }
}

function statusConexao() {
  return {
    whatsapp: connectionStatus,
    online: connectionStatus === 'conectado',
    conectado_desde: conectadoDesde ? new Date(conectadoDesde).toISOString() : null,
    uptime_processo_s: Math.round((Date.now() - startedAt) / 1000),
    ultima_entrega_confirmada: ultimaEntregaOkAt ? new Date(ultimaEntregaOkAt).toISOString() : null,
    envios_rastreados: enviosStatus.size,
    ferramentas_extras_habilitadas: EXTRAS_ON,
  };
}

// Portão de autorização: as ferramentas "extras" (áudio, vídeo, sticker, editar,
// apagar, reagir, responder, marcar_lida, presença) só aparecem/funcionam com
// HABILITAR_FERRAMENTAS_EXTRAS=true. As recomendadas ficam sempre ligadas.
const EXTRAS_ON = process.env.HABILITAR_FERRAMENTAS_EXTRAS === 'true';

// Buffer de mensagens RECEBIDAS (two-way) — últimas N mensagens de texto que
// chegaram ao número-robô, para ler_mensagens_recebidas. Memória volátil.
const MAX_INBOX = 50;
const inbox = []; // { from, texto, at, id, key, quotedRef }

async function startBaileys() {
  // Encerra o socket anterior e seus listeners antes de criar um novo — sem isso,
  // eventos 'close' de sockets antigos disparam reconexões duplicadas (loop 405).
  if (sock) { try { sock.ev.removeAllListeners(); sock.ws?.close(); } catch { /* já morto */ } }
  reconnecting = false;

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  // Busca a versão ATUAL do WhatsApp Web. Sem isso, o Baileys usa uma versão
  // embutida que pode estar velha → o WhatsApp rejeita o handshake com 405 e
  // NUNCA emite o QR. Esta é a causa nº1 do loop 405.
  const { version } = await fetchLatestBaileysVersion();
  console.log(`Baileys usando WhatsApp Web v${version.join('.')}`);

  sock = makeWASocket({ version, auth: state, logger, browser: Browsers.ubuntu('Chrome') });

  sock.ev.on('creds.update', saveCreds);

  // Recibos de entrega/leitura → atualiza o rastreio de status de cada envio.
  sock.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      const st = u?.update?.status;
      if (u?.key?.id && typeof st === 'number') registrarStatus(u.key.id, st);
    }
  });

  // Mensagens RECEBIDAS (two-way) → buffer para ler_mensagens_recebidas.
  sock.ev.on('messages.upsert', ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const m of messages) {
      if (m.key?.fromMe) continue;
      const id = m.key?.id;
      const texto = m.message?.conversation ?? m.message?.extendedTextMessage?.text;
      if (!texto || !id) continue; // só texto por ora (mídia recebida fica de fora)
      // DEDUP por id: o messages.upsert pode disparar mais de uma vez para a mesma
      // mensagem (retry/entrega dupla do Baileys) — sem isto o buffer acumulava a
      // mesma mensagem 2x com o mesmo id. Usa o timestamp REAL da mensagem quando disponível.
      if (inbox.some((e) => e.id === id)) continue;
      const at = m.messageTimestamp ? Number(m.messageTimestamp) * 1000 : Date.now();
      inbox.push({ from: m.key.remoteJid, texto, at, id, key: m.key, quotedRef: { key: m.key, message: m.message } });
      if (inbox.length > MAX_INBOX) inbox.shift();
    }
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'aguardando_qr';
      console.log('\n=== ESCANEIE O QR CODE COM O WHATSAPP (Aparelhos conectados) ===\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'conectado';
      conectadoDesde = Date.now();
      console.log('WhatsApp conectado.');
    }

    if (connection === 'close') {
      conectadoDesde = null;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      // Log completo do erro — para diagnosticar 405 (versão velha vs bloqueio de
      // IP de datacenter). Um 405 persistente mesmo com pacote/versão atuais indica
      // que o WhatsApp está recusando o IP da VM (comum em nuvem/GCP/AWS).
      console.log('DEBUG close:', JSON.stringify(lastDisconnect?.error?.output ?? { message: lastDisconnect?.error?.message }));
      const deslogado = statusCode === DisconnectReason.loggedOut;
      if (deslogado) {
        connectionStatus = 'deslogado_precisa_novo_qr';
        console.log(`Sessão encerrada (logout). Reinicie o serviço para gerar novo QR.`);
        return;
      }
      connectionStatus = 'reconectando';
      if (reconnecting) return; // já há uma reconexão agendada
      reconnecting = true;
      console.log(`Conexão fechada (statusCode=${statusCode}). Reconectando em ${RECONNECT_DELAY_MS / 1000}s...`);
      setTimeout(() => { startBaileys().catch((e) => console.error('Falha ao reconectar:', e)); }, RECONNECT_DELAY_MS);
    }
  });
}

// ── Helpers de envio (compartilhados por todas as ferramentas de envio) ───────
function precisaConectado() {
  if (!sock || connectionStatus !== 'conectado') {
    throw new Error(`WhatsApp não está conectado (status atual: ${connectionStatus}). Verifique a sessão na VM.`);
  }
}

// Resolve o JID canônico do destino via onWhatsApp — ESSENCIAL no Brasil (9º dígito).
async function destinoJid() {
  const numero = WHATSAPP_DESTINO.replace(/@.*/, '').replace(/\D/g, '');
  let jid = `${numero}@s.whatsapp.net`;
  try {
    const [info] = await sock.onWhatsApp(numero);
    if (info?.exists && info.jid) jid = info.jid;
    else console.log(`AVISO: onWhatsApp não confirmou ${numero} — usando JID cru ${jid}.`);
  } catch (e) {
    console.log(`AVISO: onWhatsApp falhou (${e.message}) — usando JID cru ${jid}.`);
  }
  return jid;
}

function esperarAck(id) {
  return new Promise((resolve) => {
    if ((enviosStatus.get(id)?.statusNum ?? 0) >= 3) return resolve(true);
    const timer = setTimeout(() => resolve((enviosStatus.get(id)?.statusNum ?? 0) >= 3), ACK_WAIT_MS);
    const arr = ackWaiters.get(id) ?? [];
    arr.push(() => { clearTimeout(timer); resolve(true); });
    ackWaiters.set(id, arr);
  });
}

const MAX_MEDIA_BYTES = 16 * 1024 * 1024; // 16MB — limite prático do WhatsApp
const FETCH_TIMEOUT_MS = 20_000;          // baixar mídia de URL
const SEND_TIMEOUT_MS = 45_000;           // upload da mídia ao WhatsApp

// Corre `promise` contra um timeout. Sem isto, uma URL lenta ou um upload travado do
// Baileys penduram a requisição MCP e "travam" o chat do orquestrador (bug relatado).
function comTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${label}: timeout após ${Math.round(ms / 1000)}s`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

// Envia um `content` Baileys (texto, imagem, documento, etc.) para o destino fixo,
// rastreia o id e espera o recibo de entrega. Retorna { id, status, entregue }.
async function enviarConteudo(content, preview, options = {}) {
  precisaConectado();
  const jid = await destinoJid();
  // Timeout no envio: mídia grande / rede instável não pode pendurar a requisição.
  const sent = await comTimeout(sock.sendMessage(jid, content, options), SEND_TIMEOUT_MS, 'envio ao WhatsApp');
  const id = sent?.key?.id ?? null;
  console.log(`Enviado id=${id} para JID=${jid}`);
  if (id) registrarStatus(id, 2, { preview: String(preview ?? '').slice(0, 80), jid });
  const entregue = id ? await esperarAck(id) : false;
  return { id, status: enviosStatus.get(id)?.status ?? 'enviado_ao_servidor', entregue };
}

// Baixa mídia de base64 (data URI ou puro) ou de uma URL pública → Buffer.
// Com timeout de download e limite de tamanho — para não pendurar nem estourar memória.
async function midiaBuffer(a) {
  let buf;
  if (a.base64) {
    buf = Buffer.from(String(a.base64).replace(/^data:[^;]+;base64,/, ''), 'base64');
  } else if (a.url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(String(a.url), { signal: ctrl.signal });
      if (!r.ok) throw new Error(`falha ao baixar a URL (HTTP ${r.status})`);
      buf = Buffer.from(await r.arrayBuffer());
    } catch (e) {
      throw new Error(e.name === 'AbortError' ? `download da URL passou de ${FETCH_TIMEOUT_MS / 1000}s (URL lenta/inacessível)` : `falha ao baixar a URL: ${e.message}`);
    } finally {
      clearTimeout(timer);
    }
  } else {
    throw new Error("forneça 'base64' (conteúdo) ou 'url' (link público) da mídia.");
  }
  if (!buf.length) throw new Error('mídia vazia.');
  if (buf.length > MAX_MEDIA_BYTES) throw new Error(`mídia muito grande (${(buf.length / 1e6).toFixed(1)}MB; máximo ${MAX_MEDIA_BYTES / 1e6}MB).`);
  return buf;
}

// Transcodifica qualquer áudio (mp3/wav/…) para ogg/opus mono via ffmpeg — exigência
// do WhatsApp para NOTA DE VOZ (PTT). Sem isto, um mp3 marcado como PTT chega "quebrado"
// ("áudio não disponível"). Requer ffmpeg instalado na VM (o startup-script instala).
function transcodeParaOpus(buffer) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-c:a', 'libopus', '-b:a', '48k', '-ar', '48000', '-ac', '1', '-f', 'ogg', 'pipe:1']);
    const out = [], err = [];
    const timer = setTimeout(() => { ff.kill('SIGKILL'); reject(new Error('transcodificação de áudio passou de 30s')); }, 30_000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.stderr.on('data', (d) => err.push(d));
    ff.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? 'ffmpeg não instalado na VM (redeploy para instalar)' : `ffmpeg: ${e.message}`)); });
    ff.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`ffmpeg falhou (code ${code}): ${Buffer.concat(err).toString().slice(0, 200)}`));
      const b = Buffer.concat(out);
      b.length ? resolve(b) : reject(new Error('transcodificação produziu áudio vazio.'));
    });
    ff.stdin.on('error', () => {}); // ignora EPIPE se o ffmpeg fechar cedo
    ff.stdin.write(buffer);
    ff.stdin.end();
  });
}

// Text-to-Speech via Google Cloud TTS (voz Neural pt-BR). Autentica por API KEY
// (env GOOGLE_TTS_API_KEY) — a VM não tem escopo cloud-platform para usar a service
// account direto. Retorna Buffer mp3. Free tier ~1M chars/mês (Neural).
const TTS_VOZ_PADRAO = 'pt-BR-Neural2-C';
async function sintetizarTTS(texto, voz, apiKey) {
  const body = { input: { text: texto }, voice: { languageCode: 'pt-BR', name: voz || TTS_VOZ_PADRAO }, audioConfig: { audioEncoding: 'MP3' } };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${encodeURIComponent(apiKey)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.audioContent) throw new Error(`Google TTS falhou (HTTP ${r.status}): ${data?.error?.message || 'sem audioContent'}`);
    return Buffer.from(data.audioContent, 'base64');
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? `Google TTS: timeout de ${FETCH_TIMEOUT_MS / 1000}s` : e.message);
  } finally {
    clearTimeout(timer);
  }
}

function mimeFromName(nome = '') {
  const ext = String(nome).toLowerCase().split('.').pop();
  return ({ pdf: 'application/pdf', csv: 'text/csv', txt: 'text/plain', json: 'application/json',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', xls: 'application/vnd.ms-excel',
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', zip: 'application/zip',
    mp3: 'audio/mpeg', ogg: 'audio/ogg', mp4: 'video/mp4' }[ext]) ?? 'application/octet-stream';
}

function respEnvio(r, tipo = 'Mensagem') {
  return {
    resultado: r.entregue
      ? `${tipo} ENTREGUE no aparelho do destinatário.`
      : `${tipo} enviada ao servidor, mas NÃO confirmada como entregue (destino pode estar offline). Reenvie/logue, ou reconfira com verificar_status_envio.`,
    entregue: r.entregue, status: r.status, id: r.id,
  };
}

function keyEnviada(id) { const rec = enviosStatus.get(id); return rec?.jid ? { remoteJid: rec.jid, fromMe: true, id } : null; }
function entradaRecebida(id) { return inbox.find((e) => e.id === id); }

// ── Registro de ferramentas ───────────────────────────────────────────────────
// extra:false = recomendada (sempre ligada). extra:true = fica atrás do portão
// HABILITAR_FERRAMENTAS_EXTRAS (desligada por padrão; implementada para exploração).
const MIDIA_PROPS = { url: { type: 'string', description: 'URL pública da mídia (alternativa a base64).' }, base64: { type: 'string', description: 'Conteúdo em base64 (alternativa a url).' } };

const TOOLS = [
  // ── Recomendadas ──
  {
    name: 'enviar_mensagem_whatsapp', extra: false,
    description: 'Envia TEXTO para o WhatsApp do operador (destino fixo no servidor). CONFIRMA A ENTREGA: retorna { entregue, status, id }. entregue=false ⇒ chegou ao servidor mas não ao aparelho (destino offline) → reenvie/logue. Aceita markdown do WhatsApp (*negrito*, _itálico_, ```mono```).',
    inputSchema: { type: 'object', properties: { texto: { type: 'string', description: 'Texto (aceita markdown do WhatsApp).' } }, required: ['texto'] },
    handler: async (a) => respEnvio(await enviarConteudo({ text: String(a.texto ?? '').trim() }, a.texto), 'Mensagem'),
    valida: (a) => { if (!String(a.texto ?? '').trim()) throw new Error("'texto' é obrigatório."); },
  },
  {
    name: 'enviar_imagem_whatsapp', extra: false,
    description: 'Envia uma IMAGEM (via url ou base64) com legenda opcional. Ideal para gráficos: payoff de trava, curva de capital, IV Rank, print do cockpit. CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { ...MIDIA_PROPS, legenda: { type: 'string', description: 'Legenda opcional.' } } },
    handler: async (a) => respEnvio(await enviarConteudo({ image: await midiaBuffer(a), caption: a.legenda || undefined }, a.legenda || 'imagem'), 'Imagem'),
  },
  {
    name: 'enviar_documento_whatsapp', extra: false,
    description: 'Envia um DOCUMENTO (PDF/CSV/XLSX/etc., via url ou base64). Ideal para relatórios: P&L mensal, auditoria, CSV de posições. Informe nome_arquivo (com extensão). CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { ...MIDIA_PROPS, nome_arquivo: { type: 'string', description: 'Nome do arquivo com extensão (ex: relatorio.pdf).' }, mimetype: { type: 'string', description: 'Opcional; inferido da extensão se omitido.' }, legenda: { type: 'string', description: 'Legenda opcional.' } }, required: ['nome_arquivo'] },
    handler: async (a) => respEnvio(await enviarConteudo({ document: await midiaBuffer(a), fileName: a.nome_arquivo, mimetype: a.mimetype || mimeFromName(a.nome_arquivo), caption: a.legenda || undefined }, a.nome_arquivo), 'Documento'),
    valida: (a) => { if (!String(a.nome_arquivo ?? '').trim()) throw new Error("'nome_arquivo' é obrigatório."); },
  },
  {
    name: 'ler_mensagens_recebidas', extra: false,
    description: 'Lê as mensagens de texto RECEBIDAS pelo número-robô (two-way). Use para o operador comandar pelo WhatsApp (ex: responder "status da carteira") — você lê aqui e age. Retorna as mais recentes primeiro. Buffer volátil (últimas 50).',
    inputSchema: { type: 'object', properties: { limite: { type: 'integer', description: 'Quantas mensagens retornar (padrão 10).' } } },
    handler: async (a) => {
      const n = Math.max(1, Math.min(50, parseInt(a.limite ?? 10, 10) || 10));
      const msgs = inbox.slice(-n).reverse().map((e) => ({ id: e.id, de: e.from, texto: e.texto, quando: new Date(e.at).toISOString() }));
      return { total_no_buffer: inbox.length, mensagens: msgs };
    },
  },
  {
    name: 'verificar_status_envio', extra: false,
    description: 'Consulta o status de entrega de um envio anterior pelo "id". Retorna se foi entregue/lido. Útil para reconferir quando o destino estava offline.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'id retornado por uma ferramenta de envio.' } }, required: ['id'] },
    handler: async (a) => {
      const id = String(a.id ?? '').trim();
      const rec = enviosStatus.get(id);
      if (!rec) return { id, encontrado: false, obs: 'id não rastreado (saiu do buffer dos últimos 300, ou inválido).' };
      return { id, encontrado: true, status: rec.status, entregue: rec.statusNum >= 3, lido: rec.statusNum >= 4, quando: new Date(rec.at).toISOString(), preview: rec.preview };
    },
    valida: (a) => { if (!String(a.id ?? '').trim()) throw new Error("'id' é obrigatório."); },
  },
  {
    name: 'verificar_status_conexao', extra: false,
    description: 'Observabilidade do canal: online? desde quando? uptime? última entrega confirmada? Use ANTES de um alerta crítico.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => statusConexao(),
  },
  {
    name: 'enviar_alerta_falado', extra: false, requerEnv: 'GOOGLE_TTS_API_KEY',
    description: 'Envia um ALERTA FALADO: recebe o TEXTO, gera a fala com voz humana (Google Cloud TTS, pt-BR Neural) e envia como NOTA DE VOZ no WhatsApp. O operador ouve o alerta sem abrir o app. CONFIRMA A ENTREGA. Ideal para risco de carteira/limite cruzado.',
    inputSchema: { type: 'object', properties: {
      texto: { type: 'string', description: 'O que será falado (pt-BR). Frases curtas soam melhor.' },
      voz: { type: 'string', description: 'Voz do TTS (padrão pt-BR-Neural2-C, feminina). Ex.: pt-BR-Neural2-B (masculina).' },
    }, required: ['texto'] },
    valida: (a) => { if (!String(a.texto ?? '').trim()) throw new Error("'texto' é obrigatório."); },
    handler: async (a) => {
      const mp3 = await sintetizarTTS(String(a.texto).trim(), a.voz, process.env.GOOGLE_TTS_API_KEY);
      const opus = await transcodeParaOpus(mp3);
      return respEnvio(await enviarConteudo({ audio: opus, mimetype: 'audio/ogg; codecs=opus', ptt: true }, String(a.texto).slice(0, 80)), 'Alerta falado');
    },
  },

  // ── Extras (atrás do portão HABILITAR_FERRAMENTAS_EXTRAS) ──
  {
    name: 'enviar_audio_whatsapp', extra: true,
    description: '[EXTRA] Envia ÁUDIO (url|base64). Com nota_de_voz=true, envia como mensagem de VOZ (PTT) — o servidor transcodifica automaticamente para ogg/opus (via ffmpeg), então qualquer formato de entrada vira nota de voz que toca. CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { ...MIDIA_PROPS, nota_de_voz: { type: 'boolean', description: 'true = mensagem de voz (PTT); o áudio é convertido para opus automaticamente.' } } },
    handler: async (a) => {
      let buf = await midiaBuffer(a);
      let mimetype = 'audio/mpeg';
      if (a.nota_de_voz) { buf = await transcodeParaOpus(buf); mimetype = 'audio/ogg; codecs=opus'; }
      return respEnvio(await enviarConteudo({ audio: buf, mimetype, ptt: !!a.nota_de_voz }, 'áudio'), 'Áudio');
    },
  },
  {
    name: 'enviar_video_whatsapp', extra: true,
    description: '[EXTRA] Envia VÍDEO (url ou base64) com legenda opcional. CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { ...MIDIA_PROPS, legenda: { type: 'string', description: 'Legenda opcional.' } } },
    handler: async (a) => respEnvio(await enviarConteudo({ video: await midiaBuffer(a), caption: a.legenda || undefined }, a.legenda || 'vídeo'), 'Vídeo'),
  },
  {
    name: 'enviar_sticker_whatsapp', extra: true,
    description: '[EXTRA] Envia um STICKER (idealmente webp, via url ou base64). CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { ...MIDIA_PROPS } },
    handler: async (a) => respEnvio(await enviarConteudo({ sticker: await midiaBuffer(a) }, 'sticker'), 'Sticker'),
  },
  {
    name: 'responder_mensagem_whatsapp', extra: true,
    description: '[EXTRA] Responde CITANDO uma mensagem recebida (reply/quote), pelo id dela (de ler_mensagens_recebidas). CONFIRMA A ENTREGA.',
    inputSchema: { type: 'object', properties: { id_recebida: { type: 'string' }, texto: { type: 'string' } }, required: ['id_recebida', 'texto'] },
    handler: async (a) => {
      const e = entradaRecebida(String(a.id_recebida));
      if (!e) throw new Error('mensagem recebida não encontrada no buffer.');
      return respEnvio(await enviarConteudo({ text: String(a.texto) }, a.texto, { quoted: e.quotedRef }), 'Resposta');
    },
  },
  {
    name: 'editar_mensagem_whatsapp', extra: true,
    description: '[EXTRA] Edita uma mensagem JÁ ENVIADA por este servidor, pelo id (ex: marcar um alerta como "resolvido").',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, novo_texto: { type: 'string' } }, required: ['id', 'novo_texto'] },
    handler: async (a) => { precisaConectado(); const k = keyEnviada(String(a.id)); if (!k) throw new Error('id enviado não encontrado.'); await sock.sendMessage(k.remoteJid, { text: String(a.novo_texto), edit: k }); return { ok: true, editada: a.id }; },
  },
  {
    name: 'apagar_mensagem_whatsapp', extra: true,
    description: '[EXTRA] Apaga PARA TODOS uma mensagem já enviada por este servidor, pelo id (retratar alerta falso).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    handler: async (a) => { precisaConectado(); const k = keyEnviada(String(a.id)); if (!k) throw new Error('id enviado não encontrado.'); await sock.sendMessage(k.remoteJid, { delete: k }); return { ok: true, apagada: a.id }; },
  },
  {
    name: 'reagir_mensagem_whatsapp', extra: true,
    description: '[EXTRA] Reage com emoji a uma mensagem (recebida ou enviada), pelo id.',
    inputSchema: { type: 'object', properties: { id: { type: 'string' }, emoji: { type: 'string' } }, required: ['id', 'emoji'] },
    handler: async (a) => { precisaConectado(); const e = entradaRecebida(String(a.id)); const k = e ? e.key : keyEnviada(String(a.id)); if (!k) throw new Error('id não encontrado (nem recebido nem enviado).'); await sock.sendMessage(k.remoteJid, { react: { text: String(a.emoji || '👍'), key: k } }); return { ok: true, reagiu_a: a.id, emoji: a.emoji }; },
  },
  {
    name: 'marcar_como_lida_whatsapp', extra: true,
    description: '[EXTRA] Marca como lida uma mensagem recebida (id específico) ou as últimas recebidas.',
    inputSchema: { type: 'object', properties: { id_recebida: { type: 'string', description: 'Opcional; se omitido, marca as últimas recebidas.' } } },
    handler: async (a) => { precisaConectado(); let keys = []; if (a.id_recebida) { const e = entradaRecebida(String(a.id_recebida)); if (!e) throw new Error('mensagem recebida não encontrada.'); keys = [e.key]; } else { keys = inbox.slice(-10).map((e) => e.key); } if (keys.length) await sock.readMessages(keys); return { ok: true, marcadas: keys.length }; },
  },
  {
    name: 'enviar_presenca_whatsapp', extra: true,
    description: '[EXTRA] Envia presença ao destino: "composing" (digitando), "recording" (gravando áudio), "paused", "available", "unavailable".',
    inputSchema: { type: 'object', properties: { tipo: { type: 'string', enum: ['composing', 'recording', 'paused', 'available', 'unavailable'] } }, required: ['tipo'] },
    handler: async (a) => { precisaConectado(); const jid = await destinoJid(); await sock.sendPresenceUpdate(String(a.tipo), jid); return { ok: true, presenca: a.tipo }; },
  },
];

// Ferramenta aparece se: (não é extra OU extras ligados) E (não requer env OU o env está setado).
const TOOLS_ATIVAS = () => TOOLS.filter((t) => (!t.extra || EXTRAS_ON) && (!t.requerEnv || process.env[t.requerEnv]));

// ── MCP — mesmo padrão stateless usado no OpLab/Cockpit: server+transport novos
// por requisição, closes ao final. ───────────────────────────────────────────
function buildMcpServer() {
  const srv = new Server({ name: 'whatsapp-mcp', version: '2.0.0' }, { capabilities: { tools: {} } });

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS_ATIVAS().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const nome = request.params.name;
    const args = request.params.arguments ?? {};
    const json = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError });
    const tool = TOOLS.find((t) => t.name === nome);
    if (!tool) return json({ erro: `Ferramenta desconhecida: ${nome}` }, true);
    if (tool.extra && !EXTRAS_ON) return json({ erro: `Ferramenta '${nome}' é EXTRA e não está autorizada. Habilite com HABILITAR_FERRAMENTAS_EXTRAS=true no servidor.` }, true);
    if (tool.requerEnv && !process.env[tool.requerEnv]) return json({ erro: `Ferramenta '${nome}' requer ${tool.requerEnv} configurada no servidor (env da VM).` }, true);
    try {
      if (tool.valida) tool.valida(args);
      return json(await tool.handler(args));
    } catch (e) {
      return json({ erro: e.message }, true);
    }
  });

  return srv;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '25mb' })); // 25mb: mídia em base64 (16MB + overhead) cabe no corpo

// /health é público de propósito (monitor externo via curl, sem segredo). Inclui a
// observabilidade completa do canal para uptime checks saberem se está entregando.
app.get('/health', (_req, res) => res.json({ status: 'ok', ...statusConexao() }));

async function handleMcp(req, res) {
  const server = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); server.close(); });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (e) {
    console.error('Erro MCP:', e);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
}

// Auth por HEADER (x-api-key) — para curl/testes e para o modo beta de "request
// headers" do claude.ai.
app.post('/mcp', (req, res) => {
  if (req.header('x-api-key') !== MCP_API_KEY) return res.status(401).json({ error: 'x-api-key inválida ou ausente' });
  return handleMcp(req, res);
});

// Auth por PATH — o conector padrão do claude.ai (fora do beta de headers) só guarda
// a URL, então a chave viaja embutida no caminho: /mcp/<chave>. É esta a URL usada
// no conector do claude.ai. Mesmo nível de segredo do header, só em outra posição.
app.post('/mcp/:key', (req, res) => {
  if (req.params.key !== MCP_API_KEY) return res.status(401).json({ error: 'chave inválida no path' });
  return handleMcp(req, res);
});

startBaileys().catch((e) => { console.error('Falha ao iniciar Baileys:', e); process.exit(1); });
app.listen(PORT, () => console.log(`[WhatsApp-MCP] Ativado na porta ${PORT}`));
