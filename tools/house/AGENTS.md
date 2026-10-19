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
- **Dot may only `POST /commands`**, within the person's grants. Everything else from a `via: dot`
  token stays 403.
- The relay's HA user is **non-admin**: its token can't change Home Assistant's setup.
  If the relay needs an admin-only HA command, find another way.
- Commands are never queued for later: if the relay is offline or silent, the answer is 504, and the
  relay drops a command that arrives after its `expires` (5 s) or twice.
- Every command, allowed or not, gets an audit row.

## Stages

1. Relay + read-only: the page, `GET /home`, `GET /dot`. Done.
2. `POST /commands`: grants checked in the Lambda, ceiling re-checked by the relay, an audit row each. Done.
3. Dot's built-in `house_control` (`tools/assistant/api/house.mjs`), with confirmation enforced in Dot's code (only after a new message from the person). Done.
4. Grants and groups editor (People & access, admins only, never via Dot), `GET /log`. Done.

What syncs by itself: states, names, and areas (grants follow a device that moves). What doesn't, on
purpose: a new area or a new domain appears only once it's in `relay/ceiling.json` (then `deploy-relay.sh`).

## The home server

Proxmox at `192.168.0.235` (`ssh root@…`); Home Assistant OS is VM 100 at `192.168.0.165`, serving
on **port 80**; the relay is its own container. From Proxmox, `pct exec <ctid> -- …` runs commands in
the relay container.
