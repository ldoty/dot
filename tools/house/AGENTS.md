# Agent notes: House

Home Assistant for dot-y.co. Read `README.md` for the pieces, routes and rows.

## Rules

- **Home Assistant never faces the internet.** No port forwards, no Nabu Casa, no HA token in AWS.
  The relay dials out; everything AWS knows came from it.
- **The ceiling only changes in git.** `relay/ceiling.json` is the most AWS can ever see or touch.
  Nothing in AWS may widen it, and the relay re-checks it on everything, even what AWS approved.
  Adding a domain (lock, cover, camera…) is an access change: ask Luke.
- **Grants only narrow.** No grant, no access; the highest matching level wins; admins have control.
  Areas are matched as they are now, so moving a device in Home Assistant moves its grants.
- **Dot may only `POST /commands` and change automations** (`POST`/`PUT`/`DELETE /automations…`), within
  the person's grants; every automation change from Dot answers 202 first and needs their own reply.
  Everything else from a `via: dot` token stays 403.
- **Automations run on the relay, not in Home Assistant.** HA's own automations need an admin token,
  which the relay must never hold. Making or changing one needs `control` on every device in it; AWS
  sends the relay only the ones whose owner still has that (`api/automations.mjs`, on every change and
  every 5 minutes), and the relay checks each action against the ceiling when it runs. They run within
  5 minutes of their time or not at all, and keep running from the relay's disk with the internet down.
- The relay's HA user is **non-admin**: its token can't change Home Assistant's setup.
  If the relay needs an admin-only HA command, find another way.
- Commands are never queued for later: if the relay is offline or silent, the answer is 504, and the
  relay drops a command that arrives after its `expires` (5 s) or twice.
- Every command, allowed or not, gets an audit row.
- **Texts from automations go only to the automation's owner**, decided in AWS from the stored
  automation (never from what the relay says), once per run, at most 10 a day each, no links, and within
  the owner's daily limit on everything Dot-y sends unasked (`send-limit.mjs`, 50 across all tools).
  What sets one off must be inside the ceiling (the relay checks) and readable by its owner (AWS checks).
- The relay must recover on its own after a power cut: its unit waits for a default route
  (network-online.target doesn't wait in the container), and it exits after 2 minutes without a
  working connection to Home Assistant or AWS so systemd restarts it. On 2026-10-19 a relay that
  started before the network sat silent until restarted by hand.

## Stages

1. Relay + read-only: the page, `GET /home`, `GET /dot`. Done.
2. `POST /commands`: grants checked in the Lambda, ceiling re-checked by the relay, an audit row each. Done.
3. Dot's built-in `house_control` (`tools/assistant/api/house.mjs`), with confirmation enforced in Dot's code (only after a new message from the person). Done.
4. Grants editor (People & access, admins only, never via Dot), `GET /log`. Done. Groups moved to
   the family's (`platform/family`); grants name them by id.
5. Automations: at a time or around sunrise/sunset, on the days of a repeat rule (the RRULE subset Lists and
   Dot's scheduled asks use: `repeat.mjs` is Lists', symlinked into `relay/`); made through Dot
   (`house_automation`), paused or deleted on the page, run by the relay. Done.
6. Who's home: `person.*` in the ceiling (state only: home / not_home; never the phone trackers
   behind them, which carry IP, MAC and access point). Automations set off by a change ("when Luke
   leaves home") and texts to the automation's owner (`api/notify.mjs`). Done.

People in Home Assistant, and the phone each follows (UniFi device trackers, enabled by hand; the
rest of UniFi's client trackers stay disabled): `person.luke_doty` ← `device_tracker.lukes_iphone_2`,
`person.amber_brackett` ← `device_tracker.iphone` (a private Wi-Fi address: if her iPhone rotates it,
link the new tracker). A person's home/away is someone's whereabouts: grant `read` on it on purpose.

What syncs by itself: states, names, and areas (grants follow a device that moves). What doesn't, on
purpose: a new area or a new domain appears only once it's in `relay/ceiling.json` (then `deploy-relay.sh`).

## The home server

Proxmox at `192.168.0.235` (`ssh root@…`); Home Assistant OS is VM 100 at `192.168.0.165`, serving
on **port 80**; the relay is its own container. From Proxmox, `pct exec <ctid> -- …` runs commands in
the relay container.
