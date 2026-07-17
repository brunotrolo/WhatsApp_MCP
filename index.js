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
  };
}

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

// ── Envio ────────────────────────────────────────────────────────────────────
async function enviarMensagem(texto) {
  if (!sock || connectionStatus !== 'conectado') {
    throw new Error(`WhatsApp não está conectado (status atual: ${connectionStatus}). Verifique a sessão na VM.`);
  }
  const numero = WHATSAPP_DESTINO.replace(/@.*/, '').replace(/\D/g, '');
  // Resolve o JID canônico via onWhatsApp — ESSENCIAL no Brasil: o "9º dígito" faz
  // o número digitado (5511976765644) divergir do JID que o WhatsApp reconhece (às
  // vezes 551176765644). Sem isso, o envio "tem sucesso" mas NÃO é entregue.
  let jid = `${numero}@s.whatsapp.net`;
  try {
    const [info] = await sock.onWhatsApp(numero);
    if (info?.exists && info.jid) {
      jid = info.jid;
    } else {
      console.log(`AVISO: onWhatsApp não confirmou ${numero} — tentando JID cru ${jid}.`);
    }
  } catch (e) {
    console.log(`AVISO: onWhatsApp falhou (${e.message}) — tentando JID cru ${jid}.`);
  }
  const sent = await sock.sendMessage(jid, { text: texto });
  const id = sent?.key?.id ?? null;
  console.log(`Enviado id=${id} para JID=${jid}`);
  if (id) registrarStatus(id, 2, { preview: texto.slice(0, 80), jid });

  // Espera curta pelo recibo de ENTREGA (delivery ack) — confirma que chegou no
  // aparelho do destinatário, não só que o servidor aceitou. Se o destino estiver
  // offline, retorna entregue=false (fica em enviado_ao_servidor) e o orquestrador
  // decide reenviar/logar. O ack de entrega independe de recibos de leitura estarem ativos.
  let entregue = false;
  if (id) {
    entregue = await new Promise((resolve) => {
      if ((enviosStatus.get(id)?.statusNum ?? 0) >= 3) return resolve(true);
      const timer = setTimeout(() => resolve((enviosStatus.get(id)?.statusNum ?? 0) >= 3), ACK_WAIT_MS);
      const arr = ackWaiters.get(id) ?? [];
      arr.push(() => { clearTimeout(timer); resolve(true); });
      ackWaiters.set(id, arr);
    });
  }
  return { id, status: enviosStatus.get(id)?.status ?? 'enviado_ao_servidor', entregue };
}

// ── MCP — mesmo padrão stateless usado no OpLab/Cockpit: server+transport novos
// por requisição, closes ao final. ───────────────────────────────────────────
function buildMcpServer() {
  const srv = new Server({ name: 'whatsapp-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'enviar_mensagem_whatsapp',
        description: 'Envia uma mensagem de texto para o WhatsApp do operador (destinatário fixo no servidor — não é parâmetro). Use para alertas. CONFIRMA A ENTREGA: espera o recibo de entrega e retorna JSON com "entregue" (true/false), "status" e "id". Se entregue=false, a mensagem chegou ao servidor mas ainda não ao aparelho (destinatário offline) — reenvie ou logue, e/ou use verificar_status_envio com o id.',
        inputSchema: {
          type: 'object',
          properties: { texto: { type: 'string', description: 'Texto da mensagem a enviar.' } },
          required: ['texto'],
        },
      },
      {
        name: 'verificar_status_envio',
        description: 'Consulta o status de entrega de uma mensagem já enviada, pelo "id" retornado por enviar_mensagem_whatsapp. Retorna se foi entregue/lido. Útil para reconferir depois, quando o destinatário estava offline no momento do envio.',
        inputSchema: {
          type: 'object',
          properties: { id: { type: 'string', description: 'O id da mensagem (campo "id" do retorno de enviar_mensagem_whatsapp).' } },
          required: ['id'],
        },
      },
      {
        name: 'verificar_status_conexao',
        description: 'Observabilidade do canal WhatsApp: diz se a sessão está ONLINE e pronta para enviar, desde quando está conectada, uptime e a última entrega confirmada. Use ANTES de disparar um alerta crítico para saber se o canal está funcionando.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    const nome = request.params.name;
    const args = request.params.arguments ?? {};
    const json = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }], isError });
    try {
      if (nome === 'enviar_mensagem_whatsapp') {
        const texto = String(args.texto ?? '').trim();
        if (!texto) throw new Error("Parâmetro 'texto' é obrigatório.");
        const r = await enviarMensagem(texto);
        return json({
          resultado: r.entregue
            ? 'ENTREGUE no aparelho do destinatário.'
            : 'Enviado ao servidor, mas NÃO confirmado como entregue (destinatário pode estar offline). Reenvie/logue, ou reconfira depois com verificar_status_envio.',
          entregue: r.entregue, status: r.status, id: r.id,
        });
      }
      if (nome === 'verificar_status_envio') {
        const id = String(args.id ?? '').trim();
        if (!id) throw new Error("Parâmetro 'id' é obrigatório.");
        const rec = enviosStatus.get(id);
        if (!rec) return json({ id, encontrado: false, obs: 'id não rastreado (pode ter saído do buffer dos últimos 300, ou id inválido).' });
        return json({ id, encontrado: true, status: rec.status, entregue: rec.statusNum >= 3, lido: rec.statusNum >= 4, quando: new Date(rec.at).toISOString(), preview: rec.preview });
      }
      if (nome === 'verificar_status_conexao') {
        return json(statusConexao());
      }
      throw new Error(`Ferramenta desconhecida: ${nome}`);
    } catch (e) {
      return json({ erro: e.message }, true);
    }
  });

  return srv;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

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
