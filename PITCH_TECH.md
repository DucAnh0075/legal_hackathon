# Tech-Pitch Aktenaufbereiter (1 Minute)

Sprachmodelle halluzinieren. In der justiz ist das inakzeptabel. Deshalb haben wir keinen Chatbot gebaut, sondern eine Agenten-Pipeline mit Verifikation im Code.

Erstens: Extraktion. Der Agent liest Text, Scans und Screenshots, auch per Vision. Jede Zeile bekommt einen festen Anker, jede Angabe muss auf einen Anker zeigen.

Zweitens: kontextbasiertes RAG. Passt die Akte ins Kontextbudget, liest das Modell alles. Ist sie zu groß, plant der Agent eigene Suchbegriffe und Dokumente, holt Treffer per BM25 aus einem lokalen Index und bekommt nur diese Stellen samt Nachbarzeilen.

Drittens: Verifikation in zwei Stufen. Code gleicht jedes Zitat mit der Originalzeile ab, Unbelegtes fliegt raus. Danach beurteilt ein zweiter Modelllauf, ob die Zeile die Aussage wirklich trägt.

Für Echtweltdaten plant der Agent Tool-Calls. Code prüft jeden Parameter vorab, die Werte kommen nie vom Modell.

Und es bleibt kosteneffizient: günstiges Flash-Modell, Caching je Dokument, und beim Ergänzen wird nur Neues gelesen.

KI liest. Code prüft. Der Richter entscheidet.

---

## Falls die Jury nachfragt (nicht Teil der Minute)

- **RAG:** Retrieval ist Volltextsuche (SQLite FTS5, BM25, Trigramme) mit vom Modell erweiterten Suchbegriffen. Embeddings nutzen wir nicht: Die Antwort muss auf wörtlich auffindbare Zeilen zurückführen.
- **Agent:** Das ist eine feste Pipeline mit Planungsschritten des Modells, keine frei laufende Schleife. In einer Strafakte ist das Absicht.
- **Modell:** DeepSeek über OpenRouter, per `.env` tauschbar.
- **Datenschutz:** Akteninhalte gehen zur Verarbeitung an OpenRouter und das Modell. Suchindex und Ablage sind lokal.
- **Tests:** Es gibt keine automatisierte Testsuite. Geprüft wird über Typecheck, Ankerprüfung und Testakten.
- **Kosten:** Siehe Abschnitt „Kosteneffizienz“ unten.

---

## Kosteneffizienz

- **Modellpreis:** `deepseek/deepseek-v4.1-flash` kostet laut OpenRouter 0,045 $ je Million Eingabe-Tokens und 0,50 $ je Million Ausgabe-Tokens (Stand 30.10.2026). Zum Vergleich: `openai/gpt-6-astra` kostet 10 $ und 50 $, also bei der Eingabe gut das 200-Fache und bei der Ausgabe das 100-Fache.
- **Extraktions-Cache:** Jedes Dokument wird einmal gelesen und das Ergebnis unter `extraktionen/` wiederverwendet.
- **Antwort-Cache:** Dieselbe Frage zur unveränderten Akte kostet keinen weiteren Modellaufruf.
- **Ergänzungsmodus:** Nachgereichte Dokumente werden extrahiert, bereits vorhandene nicht noch einmal.
- **Kontextbudget:** Über 60.000 Zeichen gehen nur Suchtreffer samt Nachbarzeilen ans Modell statt der ganzen Akte.
- **Lokale Suche:** Der Index läuft in SQLite, ohne eigenen Server und ohne laufende Kosten.

Die Gesamtkosten je Akte haben wir nicht gemessen, also keine Zahl pro Akte nennen.

---

## Spickzettel: Was ist RAG?

RAG heißt Retrieval-Augmented Generation. Das Modell antwortet nicht aus seinem Gedächtnis, sondern bekommt vorher die passenden Textstellen und antwortet auf deren Grundlage.

1. **Retrieval:** Zur Frage die relevanten Stellen suchen.
2. **Augmentation:** Diese Stellen zusammen mit der Frage in den Prompt geben.
3. **Generation:** Das Modell formuliert die Antwort aus diesen Stellen.

Das braucht man, weil ein Modell die Akte nicht kennt und große Akten nicht komplett in den Prompt passen oder ihn teuer machen. RAG allein verhindert aber keine Halluzinationen: Das Modell kann die Stellen trotzdem falsch wiedergeben. Deshalb prüfen wir die Zitate zusätzlich im Code.

**Bei uns:** Das Retrieval ist eine Stichwortsuche. Sie findet Zeilen, in denen die Suchbegriffe vorkommen, und BM25 sortiert sie nach Relevanz. Das Modell ergänzt vorher Synonyme.

### Vektordatenbank und Embeddings

Ein Embedding wandelt einen Text in eine Zahlenreihe um, die seine Bedeutung abbildet. Ähnliche Bedeutungen liegen dabei nah beieinander. Eine Vektordatenbank speichert diese Zahlenreihen und findet zu einer Frage die nächstgelegenen Textstellen. So findet die Suche „Kfz“ auch dann, wenn jemand nach „Auto“ fragt, ganz ohne gemeinsames Wort.

|                 | Stichwortsuche (haben wir)                 | Embeddings (haben wir nicht)                 |
| --------------- | ------------------------------------------ | -------------------------------------------- |
| Findet          | gleiche Wörter und Wortteile               | ähnliche Bedeutung                           |
| Stark bei       | Aktenzeichen, Namen, Daten, Beträgen       | anders formulierten Fragen                   |
| Schwach bei     | Synonymen (bei uns ergänzt das Modell sie) | exakten Kennungen und Zahlen                 |
| Nachvollziehbar | Ja, der Begriff steht in der Zeile         | Schwerer, es gibt nur einen Ähnlichkeitswert |

### Wenn die Jury fragt: „Warum keine Vektordatenbank?“

> „Haben wir bewusst nicht. In einer Akte zählen oft exakte Kennungen wie Aktenzeichen, Namen und Daten, und die findet eine Stichwortsuche zuverlässig und nachvollziehbar. Synonyme fangen wir ab, indem das Modell die Suchbegriffe erweitert. Sollte das bei großen Akten nicht reichen, wäre eine hybride Suche aus BM25 und Embeddings der nächste Schritt. Die Zitatprüfung bliebe gleich.“

### Wo die Vektoren liegen würden (noch nicht gebaut)

Am besten in der vorhandenen `cases/suche.sqlite`, zum Beispiel mit der Erweiterung `sqlite-vec`, in einer neuen Tabelle neben `zeilen`. Je Aktenzeile kommt ein Eintrag aus `case_id`, `anchor` und Vektor. Der Text selbst bleibt in `zeilen` und `case.json`, der Vektor verweist über den Anker nur darauf. So führt jeder Treffer weiter auf eine echte Fundstelle, und die Datei lässt sich wie der jetzige Index jederzeit neu aufbauen. Das Embedding-Modell könnte über die schon vorhandene ONNX Runtime lokal laufen, dann verlassen die Zeilen für die Suche den Rechner nicht.

### Falls ihr Embeddings später wirklich einbaut (erst dann so sagen)

> „Wir nutzen hybrides Retrieval: BM25 für exakte Kennungen, Embeddings für sinngleiche Formulierungen. Beide Trefferlisten führen wir zusammen, und jedes Zitat wird danach weiter deterministisch gegen die Originalzeile geprüft.“
