# WhatsApp MCP (Baileys puro)

Servidor MCP para um assistente (ex.: Claude) mandar alertas no WhatsApp pessoal do
operador, **com confirmação de entrega e observabilidade do canal**. Usa
[Baileys](https://github.com/WhiskeySockets/Baileys) diretamente (sem Evolution API,
sem Postgres, sem Redis), rodando numa VM Compute Engine `e2-micro` sempre ligada
(Always Free tier do Google Cloud — custo ~R$0/mês).

> **Por que VM e não Cloud Run?** A sessão WhatsApp Web exige um WebSocket persistente;
> o Cloud Run congela a CPU do container entre requisições. Estudo completo e histórico
> de decisões no repo [GoogleCloud_Projects](https://github.com/brunotrolo/GoogleCloud_Projects)
> (`docs/estudo-viabilidade-mcp-whatsapp.md` e `docs/whatsapp-mcp-arquitetura.md`).

## Ferramentas
| Ferramenta | O que faz |
|---|---|
| `enviar_mensagem_whatsapp(texto)` | Envia e **espera o recibo de entrega**. Retorna JSON `{ entregue, status, id }`. Se `entregue=false`, chegou ao servidor mas não ao aparelho (destinatário offline) → o orquestrador reenvia/loga. |
| `verificar_status_envio(id)` | Reconfere a entrega/leitura de um envio anterior pelo `id` (útil quando o destino estava offline no momento do envio). |
| `verificar_status_conexao()` | Observabilidade: canal online? desde quando? uptime? última entrega confirmada? Use **antes** de um alerta crítico. |

Status possíveis: `pendente` → `enviado_ao_servidor` → `entregue` → `lido`. O ack de
**entrega** independe de o destinatário ter recibos de leitura ativos; o `lido` é best-effort.
`GET /health` expõe a mesma observabilidade para monitores externos (uptime checks).

## Dois números, dois papéis
- **Remetente (robô):** número que escaneia o QR e mantém a sessão. Use um número
  **secundário** (reduz risco de banimento do principal).
- **Destino (`WHATSAPP_DESTINO`):** onde os alertas chegam — seu número principal.
- Se remetente == destino, a mensagem vai para o chat "Mensagem para mim". Use números diferentes.

## Deploy
Provisionado pelo script `scripts/aplicar_whatsapp_mcp.sh` do repo `GoogleCloud_Projects`,
que também cria a VM, o firewall, o IP estático e o HTTPS (Caddy + `sslip.io`). Este
repositório é publicado automaticamente por esse script.

## Endpoints
| Método/rota | Descrição |
|---|---|
| `POST /mcp/:key` | MCP autenticado pela **chave no path** — é esta a URL usada no conector do claude.ai: `https://<host>/mcp/<MCP_API_KEY>`. |
| `POST /mcp` | MCP autenticado pelo header `x-api-key` (curl/testes). |
| `GET /health` | Público: `{ "status": "ok", "whatsapp": "conectado" \| "reconectando" \| "aguardando_qr" \| "deslogado_precisa_novo_qr" }`. |

## Variáveis de ambiente (`/etc/systemd/system/whatsapp-mcp.env` na VM)
| Variável | Descrição |
|---|---|
| `MCP_API_KEY` | Chave exigida em `/mcp` (header) e `/mcp/:key` (path). Gerada no deploy. |
| `WHATSAPP_DESTINO` | Número de destino, só dígitos ou JID (`5511999999999` ou `...@s.whatsapp.net`). O código resolve o JID canônico via `onWhatsApp()` (trata o "9º dígito" do Brasil). |
| `PORT` | Porta interna do Node (padrão 8080; Caddy faz o HTTPS na frente). |

## Pareamento (1ª vez / após logout)
```bash
gcloud compute ssh whatsapp-mcp-vm --project=<PROJECT_ID> --zone=us-east1-b
sudo journalctl -u whatsapp-mcp -f
```
Escaneie o QR com o celular **remetente** (WhatsApp → Aparelhos conectados → Conectar um aparelho).
A sessão fica salva em `auth_info_baileys` e reconecta sozinha.

## Troubleshooting
A saga de bugs (405, `dubious ownership` do git, 9º dígito, número errado, OAuth do
conector) está documentada em `docs/whatsapp-mcp-arquitetura.md` no repo GoogleCloud_Projects
— leia antes de repetir os erros.

## Licença
MIT — ver `LICENSE`.
