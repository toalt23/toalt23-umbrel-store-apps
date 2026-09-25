# toalt23 Umbrel Community App Store

Community App Store für [umbrelOS](https://umbrel.com). Hier veröffentliche ich
meine eigenen Apps — unabhängig vom offiziellen Umbrel App Store.

## Installieren

In umbrelOS unter *App Store → ⋯ → Community App Store* diese URL hinzufügen:

```
https://github.com/toalt23/toalt23-umbrel-store-apps
```

Danach erscheinen alle unten gelisteten Apps im Store und lassen sich wie
gewohnt installieren und aktualisieren.

## Apps

| App | ID | Beschreibung |
|---|---|---|
| **ZEC Mining Node** | `toalt23-zec-mining-pool` | Solo-Mining direkt gegen den eigenen Zcash-Node — Zakura Full Node, ZIP-301 Stratum-Server und Web-UI für Mining-Adresse, Share-Difficulty und Worker-Übersicht. Stratum auf Port `3333`, Web-UI auf Port `3000`. |

## Aufbau

Dieses Repository enthält ausschließlich App-Store-Metadaten — die Dateien, die
umbrelOS beim Auflisten und Installieren liest. Kein Anwendungscode.

```
umbrel-app-store.yml      Store-ID und -Name; die Store-ID ist Präfix jeder App-ID
<app-id>/
  umbrel-app.yml          Listing: Name, Version, Beschreibung, Icon, Port
  docker-compose.yml      Services der App
  icon.svg                App-Icon
```

Pro App ein Ordner, dessen Name exakt der `id` aus ihrer `umbrel-app.yml`
entspricht. Jede App-ID beginnt mit der Store-ID `toalt23-`.

Die Anwendungs-Sourcen werden separat gepflegt; die Container-Images kommen
fertig aus öffentlichen Registries, dieses Repo baut nichts.

## Hinweise

Icons und Logos der Apps sind nicht zur Weiterverwendung freigegeben.
