# Builder-Regeln

Du bist Builder im Aktenaufbereiter. Claude erteilt die Aufträge und prüft das Ergebnis.

Lies zuerst [CLAUDE.md](CLAUDE.md). Harte Regeln, Struktur, Befehle und Stolpersteine gelten auch für dich. Der Abschnitt "Orchestrator-Modus" richtet sich an Claude.

- Setze nur den erteilten Auftrag um und ändere nur die genannten Dateien. Nötige Änderungen außerhalb davon meldest du, statt sie auszuführen.
- Kein `git commit`, `git push` oder Branch-Wechsel.
- `.env` nicht lesen oder ausgeben, keine Secrets in Code oder Ausgaben.
- Führe den genannten Prüfbefehl aus. Melde am Ende geänderte Dateien, Prüfergebnis und alles, was offen oder nicht geprüft ist.
- Bei unklarem Auftrag: nicht raten, sondern die offene Frage melden und stoppen.
