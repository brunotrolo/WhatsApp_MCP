# Arquitetura no Google Cloud — WhatsApp MCP

Documentação técnica da solução e da infraestrutura no Google Cloud. Autocontida
(este repositório é publicado automaticamente pelo script de deploy do repo
[GoogleCloud_Projects](https://github.com/brunotrolo/GoogleCloud_Projects), onde
ficam o estudo de viabilidade e a visão geral dos 3 MCPs do ecossistema).

**Última atualização:** 2026-07-17

---

## 1. O que é

Servidor MCP que dá a um assistente (ex.: Claude) a capacidade de **enviar alertas e receber
comandos** no WhatsApp pessoal do operador, com **confirmação de entrega** e **observabilidade
do canal**. Usa [Baileys](https://github.com/WhiskeySockets/Baileys) diretamente (sem Evolution
API, sem Postgres, sem Redis).

```
   claude.ai (orquestrador)
      │  HTTPS  POST https://<IP>.sslip.io/mcp/<CHAVE>
      ▼
   ┌──────────────────────── VM Compute Engine e2-micro (us-east1-b, 24/7) ────────────────────────┐
   │   Caddy (HTTPS automático, :443)  ──►  Node/Express (:8080)  ──►  Baileys (sessão WhatsApp Web) │
   └───────────────────────────────────────────────────────────────────────────────┬──────────────┘
                                                                                     │ WhatsApp Web
                                              número REMETENTE (robô) ───envia───► número DESTINO (você)
```

---

## 2. Por que Compute Engine (VM), e não Cloud Run

A sessão do WhatsApp Web (Baileys) é um **WebSocket persistente 24/7**: precisa de CPU sempre
viva (heartbeats, mensagens chegando) e de **disco persistente** para a credencial de pareamento.

O Cloud Run foi feito para o **oposto** disso:
- **Congela a CPU entre requisições** (`--cpu-throttling`) — é assim que cobra quase nada; a sessão
  morreria por falta de heartbeat.
- **Escala a zero** quando ocioso — a sessão cairia e exigiria re-parear (QR).
- **Disco efêmero** — a credencial da sessão se perderia a cada reciclagem.
- "CPU sempre alocada" resolveria, mas custa **igual a uma VM 24/7** — sem vantagem.

**Solução:** VM `e2-micro` no **Always Free tier** do Google Cloud — sempre ligada, mas **~R$0/mês**
por caber na cota gratuita permanente (1 e2-micro em us-west1/us-east1/us-central1 + 30GB de disco).

> Regra de decisão para qualquer MCP: precisa manter conexão viva o tempo todo? → VM e2-micro free
> tier. É request/response? → Cloud Run stateless. Na dúvida, Cloud Run.

---

## 3. Componentes GCP

| Componente | Recurso | Papel | Custo |
|---|---|---|---|
| Compute | VM `whatsapp-mcp-vm` (e2-micro, us-east1-b) | Roda Node + Baileys 24/7 | ~R$0 (Always Free) |
| Disco | Persistent Disk 20GB standard | SO + código + `auth_info_baileys` (sessão) | ~R$0 (free tier 30GB) |
| Rede | IP estático reservado | Hostname HTTPS estável (`<IP>.sslip.io`) | ~R$0 (grátis anexado a VM rodando) |
| HTTPS | Caddy + `sslip.io` | Certificado Let's Encrypt automático **sem domínio próprio** | ~R$0 |
| Firewall | regra `allow-whatsapp-mcp-https` | Libera 80/443 (Caddy emite/serve TLS) | — |
| Processo | systemd `whatsapp-mcp.service` | `Restart=always` (sobe no boot, reinicia em crash) | — |

**HTTPS sem domínio:** `sslip.io` é um DNS que resolve `<IP>.sslip.io` para o próprio `<IP>`.
O Caddy usa isso para tirar um certificado válido do Let's Encrypt — sem comprar/configurar domínio.
Por isso o **IP precisa ser estático**: o hostname (e o certificado) embutem o IP.

---

## 4. Modelo de autenticação

Duas rotas, mesma lógica MCP por trás:
- `POST /mcp/:key` — autentica pela **chave embutida no path**. É a URL usada no conector do
  claude.ai, porque o conector padrão (fora do beta de "request headers") só guarda a **URL**,
  sem header customizado. A chave viaja no caminho: `/mcp/<MCP_API_KEY>`.
- `POST /mcp` — autentica pelo header `x-api-key` (para curl/testes e para o beta de headers).
- `GET /health` — público (sem segredo): observabilidade do canal para uptime checks.

A `MCP_API_KEY` é gerada no primeiro deploy e fica em `/etc/systemd/system/whatsapp-mcp.env` na VM.
A ferramenta só recebe `texto`/mídia — o **destino é fixo** (env `WHATSAPP_DESTINO`), nunca um
parâmetro, para o modelo não conseguir mandar para o número errado.

---

## 5. Dois números, dois papéis (importante)
- **Remetente (robô):** número que escaneia o QR e mantém a sessão. Use um número **secundário**
  (reduz o risco de banimento do principal).
- **Destino (`WHATSAPP_DESTINO`):** onde os alertas chegam — o número principal que você lê.
- Se remetente == destino, a mensagem vai para o chat "Mensagem para mim" (parece que "não chegou").

---

## 6. Confirmação de entrega e observabilidade

O WhatsApp emite recibos por mensagem; o Baileys expõe em `messages.update`
(`pendente → enviado_ao_servidor → entregue → lido`). Toda ferramenta de envio **espera o recibo
de entrega** (até 7s) e retorna `{ entregue, status, id }` — se `entregue=false`, chegou ao
servidor mas não ao aparelho (destino offline) → o orquestrador reenvia/loga. O `GET /health` e a
ferramenta `verificar_status_conexao` expõem: online?, desde quando, uptime, última entrega
confirmada. Lista completa das ferramentas em [FERRAMENTAS.md](FERRAMENTAS.md).

---

## 7. Deploy (pipeline)

O código-fonte é editado em `patches/whatsapp_mcp/` no repo **GoogleCloud_Projects** e publicado
neste repositório pelo script `scripts/aplicar_whatsapp_mcp.sh` (rodado no Cloud Shell), que também
provisiona **tudo do zero** de forma idempotente:

1. Publica o código aqui (`git push`).
2. Habilita a API do Compute Engine no projeto.
3. Libera o firewall (80/443).
4. Reserva o IP estático.
5. Cria/atualiza a VM `e2-micro` com um `startup-script` que instala Node 20 + Caddy, clona este
   repo, sobe o systemd e configura o Caddyfile com o hostname `sslip.io`.

O `startup-script` roda em todo boot/reset e faz `git pull` (com `safe.directory` a nível de
sistema) + `npm install` + `restart` — então re-deploys atualizam o código sozinhos.

### Pareamento por QR (manual — segurança do WhatsApp, não automatizável)
```bash
gcloud compute ssh whatsapp-mcp-vm --project=<PROJECT_ID> --zone=us-east1-b
sudo journalctl -u whatsapp-mcp -f
```
Escanear com o celular **remetente**: WhatsApp → Aparelhos conectados → Conectar um aparelho.

### Conectar no claude.ai
Conectores → Adicionar conector personalizado → **URL** = `https://<IP>.sslip.io/mcp/<CHAVE>`
(nome ASCII puro, ex. `WhatsApp`; sem OAuth).

---

## 8. Custo — por que ~R$0/mês
VM (Always Free), disco (free tier), IP (grátis anexado), mensagens (Baileys não cobra por
mensagem — diferente da API oficial da Meta, ~R$0,04/msg). Única variável: **egress** (1 GB/mês
grátis) — no volume pessoal, com imagens/documentos esporádicos, sobra muito.

## 9. Limitações conhecidas
- **Risco de banimento não-zero** (WhatsApp não-oficial). Mitigação: número secundário como remetente.
- **Sem redundância**: 1 VM. `Restart=always` cobre crash do processo, não queda da VM.
- **Reautorização manual** por QR se a sessão for deslogada.

## Documentos relacionados
- [FERRAMENTAS.md](FERRAMENTAS.md) — as ferramentas MCP em detalhe.
- [TROUBLESHOOTING.md](TROUBLESHOOTING.md) — a saga de bugs enfrentados e seus fixes.
- Estudo de viabilidade e visão geral dos 3 MCPs: repo [GoogleCloud_Projects](https://github.com/brunotrolo/GoogleCloud_Projects) (`docs/`).
