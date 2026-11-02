// A stand-in for JeMPI for local end-to-end runs, implementing only the endpoints the
// identity mediator calls. Matching is deterministic: same national ID, or same given
// name, family name and date of birth. /customSearch/golden matches on family name and
// date of birth, so near-duplicates (a typo in the given name) reach the review queue.
// Not for evidence: the handover evidence comes from a run against the real JeMPI.
import http from "node:http";

const goldens = new Map(); // uid -> { uid, demographicData, uniqueGoldenRecordData, sourceId, interactions }
let seq = 0;
const uid = () => `0x${(++seq).toString(16)}`;
const same = (a, b) =>
  (a.nationalId && a.nationalId === b.nationalId) ||
  (a.givenName && a.givenName === b.givenName && a.familyName === b.familyName && a.dob && a.dob === b.dob);
const view = (g) => ({ uid: g.uid, demographicData: g.demographicData, uniqueGoldenRecordData: g.uniqueGoldenRecordData, sourceId: g.sourceId });
const expanded = (g) => ({ goldenRecord: view(g), interactionsWithScore: g.interactions.map((i) => ({ interaction: { uid: i }, score: 1 })) });

const routes = {
  "POST /JeMPI/crRegister": (b) => {
    const match = [...goldens.values()].find((g) => same(g.demographicData, b.demographicData));
    const interaction = uid();
    if (match) {
      match.interactions.push(interaction);
      match.sourceId.push(b.sourceId);
      return [200, { linkInfo: { goldenUID: match.uid, interactionUID: interaction } }];
    }
    const g = { uid: uid(), demographicData: b.demographicData, uniqueGoldenRecordData: { auxId: b.uniqueInteractionData.auxId }, sourceId: [b.sourceId], interactions: [interaction] };
    goldens.set(g.uid, g);
    return [200, { linkInfo: { goldenUID: g.uid, interactionUID: interaction } }];
  },
  "POST /JeMPI/crCandidates": (b) => [200, { goldenRecords: [...goldens.values()].filter((g) => same(g.demographicData, b.demographicData)).map(view) }],
  "POST /JeMPI/expandedGoldenRecord": (b) => (goldens.has(b.gid) ? [200, expanded(goldens.get(b.gid))] : [400, { error: "Golden Record does not exist", goldenID: b.gid }]),
  "POST /JeMPI/expandedGoldenRecords": (b) => [200, b.uidList.filter((u) => goldens.has(u)).map((u) => expanded(goldens.get(u)))],
  "GET /JeMPI/gidsAll": () => [200, { records: [...goldens.keys()] }],
  "POST /JeMPI/customSearch/golden": (b) => {
    const params = b.$or.flatMap((g) => g.parameters);
    const family = params.find((p) => p.fieldName === "familyName")?.value;
    const dob = params.find((p) => p.fieldName === "dob")?.value;
    const data = [...goldens.values()].filter((g) => g.demographicData.familyName === family && g.demographicData.dob === dob).map((g) => ({ goldenRecord: view(g) }));
    return [200, { data }];
  },
  "POST /JeMPI/relink": (b) => {
    const from = goldens.get(b.currentGoldenId);
    const to = goldens.get(b.newGoldenId);
    if (!from || !to) return [400, { message: "unknown golden record" }];
    from.interactions = from.interactions.filter((i) => i !== b.interactionId);
    to.interactions.push(b.interactionId);
    to.sourceId.push(...from.sourceId);
    if (!from.interactions.length) goldens.delete(from.uid);
    return [200, { goldenUID: to.uid }];
  },
  "POST /JeMPI/goldenRecordAuditTrail": (b) => [200, { entries: [{ goldenId: b.gid, event: "stub audit entry" }] }],
  "GET /JeMPI/countRecords": () => [200, { goldenRecords: goldens.size }],
};

http
  .createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const route = routes[`${req.method} ${req.url.split("?")[0]}`];
      const [status, body] = route ? route(raw ? JSON.parse(raw) : {}) : [404, { error: "not found" }];
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    });
  })
  .listen(50000, () => console.log("JeMPI stub on :50000"));
