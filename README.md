# claude-mod-simple-usage-bar

Eine schlichte Claude Code Mod: eine Leiste direkt über dem Eingabefeld, die deine Plan-Limits als Balken zeigt.

```
5h  ━━━━━━────────  43%  ↻ 2h 13m     Woche  ━━────────────  16%  ↻ 3d 0h     Fable  ━━━━━━━━━━────  71%  ↻ 3d 22h     ● Fable
```

- **5h**: das 5-Stunden-Limit
- **Woche**: das Wochenlimit (gesamt)
- **Fable**: das Fable-Wochenlimit, ein- und ausblendbar
- Farbe nach Auslastung: grün unter 50 %, gelb ab 50 %, rot ab 80 %
- Zeit bis zum Reset, jede Minute aktualisiert

In der Desktop-App sind die Balken echte, abgerundete SVG-Balken, im Terminal durchgezogene Linien.

## Installation

In einer Claude Code Terminal-Session eingeben:

```
/plugin install usage-bar --marketplace sebastian1747/claude-mod-simple-usage-bar
```

`y` bestätigt den Marketplace, danach den Scope wählen (User-Scope: die Leiste erscheint in jeder Session, auch im Code-Tab der Desktop-App).

## Bedienung

- **● Fable / ○ Fable** rechts in der Leiste anklicken, um das Fable-Limit ein- oder auszublenden
- oder `/usage-bar fable` eingeben
- Die Wahl bleibt über Sessions hinweg erhalten.
- Einklappen lässt sich die Leiste über das `[-]` daneben.

## Woher die Zahlen kommen

- **5h und Woche** liefert Claude Code nach jeder Antwort selbst (`$.session.usage()` und das Event `session.measure`).
- **Fable** und ein frischer Stand beim Start der Session kommen vom selben Endpunkt, den auch `/usage` liest (`https://api.anthropic.com/api/oauth/usage`). Die Mod fragt ihn beim Start und danach höchstens alle 3 Minuten nach einer Antwort ab, bei Fehlern (401/403/429) pausiert sie 15 Minuten.
- Dafür nutzt sie den Login der Session über `$.session.authorize()`: Claude Code setzt das Token selbst ein, die Mod sieht es nie. Es gehen keine Daten an andere Server.
- Der letzte Stand wird lokal gespeichert, damit eine neue Session sofort etwas anzeigt („Stand vor …“).

## Hinweise

- Die Limits gibt es nur mit einem claude.ai-Abo (Pro, Max, Team, Enterprise). Mit API-Key zeigt die Leiste nur die Kosten der Session.
- Der `/usage`-Endpunkt ist nicht offiziell dokumentiert und kann sich ändern. Dann steht dort „Fable: keine Daten“, 5h und Woche funktionieren weiter.
- Mods sind ein Early-Access-Feature von Claude Code; die API kann sich zwischen Versionen ändern.
- Die Prozente sind der Stand der letzten API-Antwort bzw. des letzten Abrufs. Bei mehreren offenen Sessions können sie leicht voneinander abweichen.

## Entwicklung

```
claude plugin validate .
claude plugin test .
```

Zum Ausprobieren ohne Installation: `claude --plugin-dir <Pfad zu diesem Ordner>`.
