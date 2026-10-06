// Dot reading the household budget for the person asking, with that person's own access.
// Each read borrows a short-lived, read-only Budget token for them (platform/api/delegation.mjs),
// so Budget decides what they may see, and every read goes in the audit log.

const DOCS = ['shared', 'Luke', 'Amber'];

export function makeBudget({ tokenFor, apiUrl, clientId, user, channel = 'web', audit = async () => {}, fetch = globalThis.fetch }) {
  async function getAll() {
    const record = (outcome, detail) => audit({ tool: 'family_budget', action: 'GET /all', outcome, ...(detail ? { detail } : {}) });
    let token;
    try {
      token = await tokenFor({ clientId, sub: user.sub, username: user.username, channel });
    } catch (e) {
      await record(e.denied ? 'denied' : 'error', e.message);
      throw new Error(e.denied ? 'This person doesn’t have access to the budget.' : 'Couldn’t reach the budget right now.');
    }
    const res = await fetch(`${apiUrl}/all`, { headers: { authorization: `Bearer ${token}` } });
    if (res.status === 403) { await record('denied', 'budget refused'); throw new Error('This person doesn’t have access to the budget.'); }
    if (!res.ok) { await record('error', `budget ${res.status}`); throw new Error(`Couldn’t read the budget (${res.status}).`); }
    await record('ok');
    return res.json();
  }

  return {
    docs: DOCS,
    /** One budget's working copy, its saved versions and tags; or a saved version, by name or tag */
    async read({ doc = 'shared', version } = {}) {
      if (!DOCS.includes(doc)) throw new Error(`Unknown budget "${doc}". Use one of: ${DOCS.join(', ')}`);
      const all = await getAll();
      const tags = all.tags[doc] || [];
      const versions = (all.versions[doc] || []).map((v) => ({
        name: v.name, saved_at: new Date(v.savedAt).toISOString(), tags: tags.filter((t) => t.versionId === v.id).map((t) => t.name),
      }));
      if (version) {
        const v = (all.versions[doc] || []).find((x) => x.name === version)
          || (all.versions[doc] || []).find((x) => x.id === tags.find((t) => t.name === version)?.versionId);
        if (!v) throw new Error(`No saved version or tag "${version}" in the ${doc} budget. Saved: ${versions.map((x) => x.name).join(', ') || 'none'}`);
        return { budget: doc, version: v.name, saved_at: new Date(v.savedAt).toISOString(), state: v.state };
      }
      const out = { budget: doc, working_copy: all.docs[doc]?.state ?? null, versions };
      // The Planning tab's named plans belong with Shared: which Shared tag applies from which month
      // (named with the version it points to now), one-off amounts, and the starting balance
      if (doc === 'shared' && all.plans?.length) {
        const versionOf = (tag) => (all.versions.shared || []).find((v) => v.id === tags.find((t) => t.name === tag)?.versionId)?.name ?? null;
        out.plans = all.plans.map(({ name, plan: p }) => ({
          name, start: p.start, months: p.months, starting_balance: p.balance,
          steps: p.steps.map((s) => ({ from: s.from, tag: s.tag, version: versionOf(s.tag) })),
          one_offs: p.oneOffs.map((o) => ({ month: o.month, label: o.label, amount: o.amount })),
        }));
      }
      return out;
    },
  };
}
