// ─────────────────────────────────────────────────────────────────────────────
// WhatsApp MCP — Baileys puro (sem Evolution API, sem Postgres, sem Redis).
// Rodando numa VM Compute Engine e2-micro sempre ligada (Always Free tier),
// porque a sessão WhatsApp Web exige WebSocket persistente — incompatível com
// Cloud Run/serverless (ver docs/estudo-viabilidade-mcp-whatsapp.md).
//
// Uma ferramenta só: enviar_mensagem_whatsapp(texto). O destinatário é FIXO
// (env WHATSAPP_DESTINO), não é parâmetro da ferramenta — evita que uma
// alucinação do modelo mande mensagem pro número errado.
// ─────────────────────────────────────────────────────────────────────────────

import express from 'express';
import pino from 'pino';
import qrcodeTerminal from 'qrcode-terminal';
import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
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

async function startBaileys() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  sock = makeWASocket({ auth: state, logger, printQRInTerminal: false });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      connectionStatus = 'aguardando_qr';
      console.log('\n=== ESCANEIE O QR CODE COM O WHATSAPP (Aparelhos conectados) ===\n');
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === 'open') {
      connectionStatus = 'conectado';
      console.log('WhatsApp conectado.');
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const deslogado = statusCode === DisconnectReason.loggedOut;
      connectionStatus = deslogado ? 'deslogado_precisa_novo_qr' : 'reconectando';
      console.log(`Conexão fechada (statusCode=${statusCode}). ${deslogado ? 'Sessão encerrada — reinicie o serviço para gerar novo QR.' : 'Reconectando...'}`);
      if (!deslogado) startBaileys(); // reconecta, exceto se foi logout explícito (precisa de novo QR manual)
    }
  });
}

// ── Envio ────────────────────────────────────────────────────────────────────
async function enviarMensagem(texto) {
  if (!sock || connectionStatus !== 'conectado') {
    throw new Error(`WhatsApp não está conectado (status atual: ${connectionStatus}). Verifique a sessão na VM.`);
  }
  await sock.sendMessage(WHATSAPP_DESTINO, { text: texto });
}

// ── MCP — mesmo padrão stateless usado no OpLab/Cockpit: server+transport novos
// por requisição, closes ao final. ───────────────────────────────────────────
function buildMcpServer() {
  const srv = new Server({ name: 'whatsapp-mcp', version: '1.0.0' }, { capabilities: { tools: {} } });

  srv.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'enviar_mensagem_whatsapp',
        description: 'Envia uma mensagem de texto para o WhatsApp pessoal do operador (destinatário fixo, configurado no servidor — não é parâmetro). Use para alertas (ex: risco de carteira, limite de delta cruzado).',
        inputSchema: {
          type: 'object',
          properties: { texto: { type: 'string', description: 'Texto da mensagem a enviar.' } },
          required: ['texto'],
        },
      },
    ],
  }));

  srv.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'enviar_mensagem_whatsapp') {
      throw new Error(`Ferramenta desconhecida: ${request.params.name}`);
    }
    const texto = String(request.params.arguments?.texto ?? '').trim();
    if (!texto) throw new Error("Parâmetro 'texto' é obrigatório.");
    try {
      await enviarMensagem(texto);
      return { content: [{ type: 'text', text: 'Mensagem enviada com sucesso.' }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Erro ao enviar: ${e.message}` }], isError: true };
    }
  });

  return srv;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// /health é público de propósito (monitoramento simples via curl, sem segredo).
app.get('/health', (_req, res) => res.json({ status: 'ok', whatsapp: connectionStatus }));

app.post('/mcp', async (req, res) => {
  if (req.header('x-api-key') !== MCP_API_KEY) {
    res.status(401).json({ error: 'x-api-key inválida ou ausente' });
    return;
  }
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
});

startBaileys().catch((e) => { console.error('Falha ao iniciar Baileys:', e); process.exit(1); });
app.listen(PORT, () => console.log(`[WhatsApp-MCP] Ativado na porta ${PORT}`));
