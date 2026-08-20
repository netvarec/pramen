// File storage end-to-end: the full R2-backed flow over the real Worker route in
// miniflare — request a signed upload url, PUT bytes, attach the FileRef to a note,
// then mint + follow a signed download url. Also covers ACL (you can only sign a
// download for a note you can read), the fileRef codec (object round-trips through
// the DB), and token hardening (missing/tampered tokens rejected).

import { assert, http, token } from "../lib";

export async function runFiles(base: string): Promise<void> {
  const TENANT = "files-demo";
  const call = http(base, TENANT);

  const T = {
    alice: await token("alice", ["author"], { tenants: [TENANT] }),
    bob: await token("bob", ["author"], { tenants: [TENANT] }),
  };

  // Raw upload/download go straight to the Worker /files/* route. Signed urls are
  // relative, so resolve them against the base.
  const put = (url: string, body: string, contentType: string) =>
    fetch(base + url, { method: "PUT", headers: { "content-type": contentType }, body }).then(async (r) => ({
      status: r.status,
      body: (await r.json().catch(() => ({}))) as any,
    }));
  const get = (url: string) => fetch(base + url);

  // --- a note to attach a file to ---
  const note = await call("createNote", { title: "with-file", body: "see attachment" }, T.alice);
  assert(note.body.ok, "files: author created a note");
  const noteId = note.body.result.id;

  // --- anonymous cannot request an upload ---
  const anon = await call("requestUpload", { contentType: "text/plain" });
  assert(anon.status === 403 && anon.body.code === "forbidden", "files: anonymous upload request is forbidden (403)");

  // --- 1) request a signed upload url ---
  const prep = await call("requestUpload", { contentType: "text/plain", filename: "note.txt" }, T.alice);
  assert(prep.body.ok && typeof prep.body.result.url === "string", "files: requestUpload returns a signed url");
  const { url: uploadUrl, ref } = prep.body.result;
  assert(ref.key.startsWith(`${TENANT}/`), "files: the minted key is tenant-scoped");

  // --- 2) PUT the bytes directly to R2 via the Worker ---
  const payload = "hello pramen files";
  const up = await put(uploadUrl, payload, "text/plain");
  assert(up.status === 200 && up.body.ok, "files: upload succeeds");
  assert(up.body.result.size === payload.length, "files: upload reports the byte size");
  assert(up.body.result.key === ref.key, "files: upload stored under the minted key");

  // --- 3) attach the ref to the note (verifies the blob exists in R2) ---
  const attached = await call("attachToNote", { id: noteId, ref }, T.alice);
  assert(attached.body.ok && attached.body.result, "files: attachToNote persisted");
  assert(attached.body.result.attachment?.key === ref.key, "files: fileRef object round-trips through the DB");
  assert(attached.body.result.attachment?.size === payload.length, "files: attach captured the real size from R2");

  // --- the fileRef survives a normal read (codec: TEXT JSON -> object) ---
  const got = await call("getNote", { id: noteId }, T.alice);
  assert(got.body.result?.attachment?.contentType === "text/plain", "files: fileRef decodes on read");

  // --- 4) mint a download url + follow it ---
  const dl = await call("getNoteAttachment", { id: noteId }, T.alice);
  assert(dl.body.ok && typeof dl.body.result.url === "string", "files: getNoteAttachment returns a signed download url");
  const downloaded = await get(dl.body.result.url);
  assert(downloaded.status === 200, "files: download responds 200");
  assert((await downloaded.text()) === payload, "files: downloaded bytes match what was uploaded");
  assert(
    (downloaded.headers.get("content-disposition") ?? "").includes("note.txt"),
    "files: download carries the original filename",
  );

  // --- a non-ASCII filename survives the round trip ---
  // Regression: the quoted `filename="…"` is a WebIDL ByteString, so reflecting the raw
  // name into it threw on any code point > U+00FF and 500'd the download. The ASCII
  // fallback is folded; the real name rides in the RFC 5987 `filename*` parameter.
  const cjk = await call("createNote", { title: "cjk-file", body: "非 ASCII" }, T.alice);
  const cjkPrep = await call("requestUpload", { contentType: "application/pdf", filename: "报告.pdf" }, T.alice);
  await put(cjkPrep.body.result.url, "pdf bytes", "application/pdf");
  await call("attachToNote", { id: cjk.body.result.id, ref: cjkPrep.body.result.ref }, T.alice);
  const cjkDl = await call("getNoteAttachment", { id: cjk.body.result.id }, T.alice);
  const cjkDownloaded = await get(cjkDl.body.result.url);
  assert(cjkDownloaded.status === 200, "files: a non-ASCII filename still downloads (200, not 500)");
  const cd = cjkDownloaded.headers.get("content-disposition") ?? "";
  assert(cd.includes("filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf"), "files: download carries the UTF-8 filename* parameter");
  assert(cd.includes(`filename="__.pdf"`), "files: download keeps an ASCII-only quoted fallback");

  // --- an UNPAIRED surrogate in the filename doesn't poison the download ---
  // JSON admits "\ud800", and it survives the signed token intact (JSON.stringify escapes it
  // back to ASCII, so the TextEncoder never folds it to U+FFFD). Left in, encodeURIComponent
  // throws a URIError and the file 500s for every caller, forever. It is dropped instead.
  const lone = await call("createNote", { title: "lone-surrogate", body: "malformed name" }, T.alice);
  const lonePrep = await call("requestUpload", { contentType: "application/pdf", filename: "a\uD800b.pdf" }, T.alice);
  await put(lonePrep.body.result.url, "pdf bytes", "application/pdf");
  await call("attachToNote", { id: lone.body.result.id, ref: lonePrep.body.result.ref }, T.alice);
  const loneDl = await call("getNoteAttachment", { id: lone.body.result.id }, T.alice);
  const loneDownloaded = await get(loneDl.body.result.url);
  assert(loneDownloaded.status === 200, "files: an unpaired surrogate in the filename still downloads (200, not 500)");
  assert(
    (loneDownloaded.headers.get("content-disposition") ?? "").includes(`filename="ab.pdf"`),
    "files: the unpaired surrogate is dropped from the filename",
  );

  // --- ACL: bob can't read alice's note, so he gets no download url ---
  const bobDl = await call("getNoteAttachment", { id: noteId }, T.bob);
  assert(bobDl.body.ok && bobDl.body.result === null, "files: another author cannot sign a download (row ACL)");

  // --- maxSize: an over-size body is rejected (413), even though the cap is small ---
  const tiny = await call("requestTinyUpload", { contentType: "text/plain" }, T.alice);
  const tooBig = await put(tiny.body.result.url, "way more than eight bytes", "text/plain");
  assert(tooBig.status === 413, "files: upload exceeding maxSize is rejected (413)");
  const okSize = await call("requestTinyUpload", { contentType: "text/plain" }, T.alice);
  const small = await put(okSize.body.result.url, "tiny", "text/plain");
  assert(small.status === 200, "files: upload within maxSize succeeds");

  // --- hardening: missing + tampered tokens are rejected ---
  const noToken = await get("/files/download");
  assert(noToken.status === 401, "files: download without a token is 401");
  // Append junk to the signed token — any change invalidates the HMAC.
  const badSig = await get(dl.body.result.url + "xectn");
  assert(badSig.status === 403, "files: a tampered token is 403");
}
