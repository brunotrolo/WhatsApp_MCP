# Troubleshooting — WhatsApp MCP

A saga de bugs enfrentados ao colocar este MCP em produção, com sintoma → causa → fix.
Leia antes de repetir os erros. (Registro histórico; a maioria já está corrigida no código/deploy.)

| Sintoma | Causa raiz | Correção |
|---|---|---|
| Loop `statusCode 405`, QR nunca aparece | Versão do WhatsApp Web embutida no Baileys estava velha | `fetchLatestBaileysVersion()` + bump do pacote `@whiskeysockets/baileys` |
| Reconexão em "martelo" (405 a cada ~2s) | Reconexão instantânea empilhava sockets | Delay de 5s + flag anti-sobreposição + `removeAllListeners()` antes de recriar |
| Código novo nunca subia após deploy | `git pull` (como root) falhava com `detected dubious ownership` (repo tem dono `whatsapp-mcp`); `set -e` abortava o startup-script antes do restart | `git config --system --add safe.directory /opt/whatsapp-mcp` (o `--global` não vale no boot, onde `HOME` ≠ `/root`) + `-c safe.directory` inline no pull |
| VM seguia no código antigo após reset | `systemctl enable --now` não reinicia serviço já rodando | Trocar por `systemctl enable` + `systemctl restart` |
| "Mensagem enviada com sucesso" mas **não chega** | "9º dígito" do Brasil: `5511976765644@...` ≠ JID registrado | Resolver o JID via `sock.onWhatsApp(numero)` antes de enviar |
| Mensagem "não chega" (mesmo com JID certo) | Remetente == destino → foi para o chat "Mensagem para mim" | Parear o robô com um número **diferente** do destino |
| claude.ai: "não foi possível registrar no serviço de login / OAuth" | Endpoint indisponível (VM em reset) **ou** faltava a rota `/mcp/:key` (código antigo) | Esperar o servidor voltar; garantir código novo; usar a URL `/mcp/<chave>` |
| `curl /mcp/<chave>` → `Cannot POST` (404) | VM rodando código antigo (deploy/reset ainda em `npm install`) | Forçar na VM: `git pull && npm install && systemctl restart`; conferir `grep 'mcp/:key' index.js` |
| SSH: `Connection refused` / `insufficient scopes` | VM ainda bootando após `reset`; ou rodar `gcloud ssh` de dentro da própria VM | Esperar ~60-90s; rodar `gcloud` sempre do **Cloud Shell**, não da VM |
| `git pull` na VM: "Already up to date" mas código velho | O deploy publica só no **passo 1** (Cloud Shell); rodar comandos na VM não republica | Rodar o script de deploy no **Cloud Shell**, não colar comandos soltos na VM |
| Avisos `Gaia id not found` / `Regional Access Boundary 404` no `gcloud` | Ruído do Cloud Shell/telemetria | Inofensivo — o deploy conclui (`Done.`) |
| `stream errored out` 515 logo após o QR | Comportamento **normal** do Baileys pós-pareamento ("restart required") | Nenhuma — o código reconecta em 5s e conecta |
| `401 conflict device_removed` | O aparelho foi removido em "Aparelhos conectados" (ou re-pareado) | Reiniciar o serviço gera novo QR |

## Regra de ouro dos dois terminais
- **Cloud Shell** (prompt `@cloudshell`): roda o script de deploy e comandos `gcloud`.
- **Dentro da VM** (prompt `@whatsapp-mcp-vm`, após `gcloud compute ssh`): roda `sudo systemctl`,
  `journalctl`, `git -C /opt/whatsapp-mcp`.
- Nunca colar `exit` junto com o próximo comando (o `exit` fecha a sessão e o resto se perde).
- Para rodar um comando na VM a partir do Cloud Shell sem entrar/sair de SSH:
  `gcloud compute ssh <vm> --zone=... --command="<comando>"`.

## Se a sessão cair (logout remoto, troca de aparelho)
`GET /health` reporta `deslogado_precisa_novo_qr`. Refaça o pareamento:
```bash
# na VM:
sudo systemctl stop whatsapp-mcp
sudo rm -rf /opt/whatsapp-mcp/auth_info_baileys
sudo systemctl start whatsapp-mcp
sudo journalctl -u whatsapp-mcp -f   # escaneie o novo QR
```

## Diagnóstico útil
```bash
curl -s https://<IP>.sslip.io/health                 # canal online?
sudo journalctl -u whatsapp-mcp -n 50 --no-pager     # logs recentes
sudo systemctl status whatsapp-mcp --no-pager        # estado do serviço
```
