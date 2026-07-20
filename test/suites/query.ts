// Query expressiveness: comparison operators, IN, LIKE, ne, AND/OR groups,
// multi-column orderBy, and limit/offset pagination. Run as admin (allow read)
// so ACL row-scope doesn't mask the operator behaviour.

import { assert, http, token } from "../lib";

export async function runQuery(base: string): Promise<void> {
  const TENANT = "query-demo";
  const post = http(base, TENANT);
  const admin = await token("admin", ["admin"]);

  const mk = async (title: string) => (await post("createNote", { title, body: "x" }, admin)).body.result.id as number;
  const a1 = await mk("alpha-1");
  const a2 = await mk("alpha-2");
  const b1 = await mk("beta-1");

  const titles = async (input: unknown): Promise<string[]> => {
    const r = await post("queryNotes", input, admin);
    assert(r.status === 200, `queryNotes ok for ${JSON.stringify(input)}`);
    return r.body.result.map((n: any) => n.title);
  };

  // LIKE
  let t = await titles({ where: { title: { like: "alpha%" } } });
  assert(t.length === 2 && t.every((x) => x.startsWith("alpha")), "LIKE 'alpha%' matches the two alphas");

  // IN
  t = await titles({ where: { id: { in: [a1, b1] } } });
  assert(t.length === 2 && t.includes("alpha-1") && t.includes("beta-1"), "IN [id] matches the two ids");

  // gt
  t = await titles({ where: { id: { gt: a1 } } });
  assert(t.length === 2 && !t.includes("alpha-1"), "gt excludes the first id");

  // ne
  t = await titles({ where: { title: { ne: "beta-1" } } });
  assert(t.length === 2 && !t.includes("beta-1"), "ne excludes beta-1");

  // OR group
  t = await titles({ where: { OR: [{ title: { eq: "alpha-1" } }, { title: { eq: "beta-1" } }] } });
  assert(t.length === 2 && t.includes("alpha-1") && t.includes("beta-1"), "OR group matches either branch");

  // AND of operators on the same/different columns
  t = await titles({ where: { title: { like: "alpha%" }, id: { gte: a2 } } });
  assert(t.length === 1 && t[0] === "alpha-2", "implicit AND of like + gte narrows to one");

  // multi-column orderBy
  t = await titles({ orderBy: [{ column: "title", dir: "asc" }] });
  assert(JSON.stringify(t) === JSON.stringify(["alpha-1", "alpha-2", "beta-1"]), "orderBy title asc sorts");

  // pagination: limit + offset over a stable order
  t = await titles({ orderBy: [{ column: "id", dir: "asc" }], limit: 1, offset: 1 });
  assert(t.length === 1 && t[0] === "alpha-2", "limit 1 offset 1 returns the second row");

  // offset past the end yields nothing
  t = await titles({ orderBy: [{ column: "id", dir: "asc" }], offset: 99 });
  assert(t.length === 0, "offset past the end returns no rows");

  // structured string ops — auto-escaped, so the needle's %/_ are literal (unlike raw `like`)
  await mk("50%_off");
  t = await titles({ where: { title: { contains: "lpha" } } });
  assert(t.length === 2 && t.every((x) => x.includes("lpha")), "contains matches a substring");
  t = await titles({ where: { title: { startsWith: "beta" } } });
  assert(t.length === 1 && t[0] === "beta-1", "startsWith matches the prefix");
  t = await titles({ where: { title: { endsWith: "-1" } } });
  assert(t.includes("alpha-1") && t.includes("beta-1") && !t.includes("alpha-2"), "endsWith matches the suffix");
  // the % and _ in the needle are literal, so this only matches "50%_off"
  t = await titles({ where: { title: { contains: "50%_off" } } });
  assert(t.length === 1 && t[0] === "50%_off", "contains escapes %/_ — literal match, no wildcard");
  t = await titles({ where: { title: { contains: "a_p" } } });
  assert(t.length === 0, "contains treats _ literally (does not match 'alpha')");

  // NOT negates a whole subtree
  t = await titles({ where: { NOT: { title: { startsWith: "alpha" } } } });
  assert(!t.some((x) => x.startsWith("alpha")) && t.includes("beta-1"), "NOT excludes the alphas");

  void a2; // (referenced via expectations above)
}
