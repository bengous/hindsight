# Records the README demo from the sandbox built by `bun docs/demo/sandbox.ts /tmp/hs-demo`.
# Run it from the repository root under a clean environment: variables inherited from a Claude Code session turn
# transcript saving off, and the Debrief needs the transcript.
#   env -i HOME="$HOME" USER="$USER" PATH="$PATH" LANG=C.UTF-8 TERM=xterm-256color vhs docs/demo/demo.tape
# Claude Code runs inside tmux: Wait+Screen reads the terminal buffer from its top, which goes stale once output
# scrolls; tmux draws on the alternate screen, which has no scrollback.

Output "/tmp/hs-demo/demo.mp4"

Require claude
Require sqlite3

Set Shell "bash"
Set FontFamily "CaskaydiaMono Nerd Font Mono"
Set FontSize 16
Set Width 1560
Set Height 900
Set Padding 16
Set Theme "GitHub Dark"
Set TypingSpeed 45ms
Set WaitTimeout 150s

Hide
Type `. /tmp/hs-demo/env.sh && db() { sqlite3 -box "$XDG_STATE_HOME/hindsight/hindsight.sqlite" "$1"; }` Enter
Type "clear && tmux -L hs-vhs -f docs/demo/tmux.conf new-session -s demo /tmp/hs-demo/claude-demo" Enter
Wait+Screen /Proposals en attente/
Show

Sleep 2.5s
Type "ajoute la dépendance dayjs"
Sleep 500ms
Enter
Wait+Screen /· done [0-9]/
Sleep 2.5s

Type "non, pas de npm pour ça, c'est un dépôt pnpm"
Sleep 500ms
Enter
Sleep 3s
Wait+Screen /retenue/
Sleep 3s

Type "/hindsight review"
Sleep 500ms
Enter
Wait+Screen /1 sur 2/
Sleep 5s
Type "n"
Wait+Screen /2 sur 2/
Sleep 4s
Type "r"
Wait+Screen /Pourquoi ce rejet/
Sleep 2s
Type "2"
Wait+Screen /rejetée/
Sleep 3s
Type "a"
Wait+Screen /Aucune Proposal en attente/
Sleep 3s
Escape
Sleep 1s
Type "/exit"
Sleep 300ms
Enter
Sleep 2s

Hide
Type "cd /tmp/hs-demo/atelier && clear" Enter
Show
Type "git --no-pager log -1 -p"
Sleep 300ms
Enter
Sleep 6s
Type "db 'select state, decision, reason, substr(commit_sha, 1, 7) as sha from proposals join decisions on decisions.proposal_id = proposals.id'"
Sleep 300ms
Enter
Sleep 4s
Type "db 'select kind, status, count(*) as n from notes group by kind, status'"
Sleep 300ms
Enter
Sleep 6s
