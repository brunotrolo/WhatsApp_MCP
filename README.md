# WhatsApp MCP (Baileys puro)

Servidor MCP com uma única ferramenta — `enviar_mensagem_whatsapp(texto)` — para mandar
alertas pro WhatsApp pessoal do operador. Usa [Baileys](https://github.com/WhiskeySockets/Baileys)
diretamente (sem Evolution API, sem Postgres, sem Redis), rodando numa VM Compute Engine
`e2-micro` sempre ligada (Always Free tier do Google Cloud — custo ~R$0/mês).

**Por que precisa de VM (não Cloud Run)?** A sessão WhatsApp Web exige uma conexão
WebSocket persistente e contínua. O Cloud Run congela a CPU do container entre
requisições (é assim que ele cobra quase nada) — incompatível com manter uma sessão
sempre viva. Ver `docs/estudo-viabilidade-mcp-whatsapp.md` no repo
[GoogleCloud_Projects](https://github.com/brunotrolo/GoogleCloud_Projects) para o
estudo completo.

## Deploy

Este repositório é publicado automaticamente pelo script
`scripts/aplicar_whatsapp_mcp.sh` do repo `GoogleCloud_Projects` — que também
provisiona a VM, o firewall, o IP estático e o HTTPS (Caddy + `sslip.io`). Não é
necessário rodar nada manualmente aqui além do pareamento inicial por QR code.

## Primeira vez — pareamento do WhatsApp (manual, uma única vez)

```bash
gcloud compute ssh whatsapp-mcp-vm --project=<PROJECT_ID> --zone=us-east1-b
sudo journalctl -u whatsapp-mcp -f
```

Escaneie o QR code que aparecer com **WhatsApp → Aparelhos conectados → Conectar
um aparelho**, no celular que você quer usar como remetente. Depois disso a sessão
fica salva em `/opt/whatsapp-mcp/auth_info_baileys` e reconecta sozinha.

## Variáveis de ambiente (`/etc/systemd/system/whatsapp-mcp.env` na VM)

| Variável | Descrição |
|---|---|
| `MCP_API_KEY` | Chave exigida no header `X-API-Key` de toda chamada a `/mcp`. Gerada automaticamente no deploy. |
| `WHATSAPP_DESTINO` | JID fixo do destinatário (`5511999999999@s.whatsapp.net`). Não é parâmetro da ferramenta — evita mandar pra número errado por engano do modelo. |
| `PORT` | Porta interna do Node (padrão 8080; Caddy faz o proxy HTTPS na frente). |

## Endpoints

- `POST /mcp` — protocolo MCP (Streamable HTTP), exige `X-API-Key`.
- `GET /health` — público, sem segredo: `{ "status": "ok", "whatsapp": "conectado" | "reconectando" | "aguardando_qr" | "deslogado_precisa_novo_qr" }`.

## Se a sessão cair (deslogado remotamente, troca de celular)

`GET /health` reporta `deslogado_precisa_novo_qr`. Reinicie o serviço
(`sudo systemctl restart whatsapp-mcp`) e repita o passo de pareamento acima —
não tem como automatizar essa etapa, é segurança do próprio WhatsApp.
