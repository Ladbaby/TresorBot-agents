// The bundle digest, in one place.
//
// Both the packer and the tests use this, so a published digest and a verified
// digest cannot drift apart. It must match TresorBot's
// internal/adapters.SourceDigest exactly: filenames sorted, each entry framed as
// <len(name)>:<name><len(body)>:<body>, where every length is a UTF-8 byte
// count.
//
// Byte counts, not string lengths, is the whole subtlety. JavaScript measures
// strings in UTF-16 code units and Go measures bytes, so a length-based scheme
// agrees only while an adapter is pure ASCII. The first em dash in a description
// would otherwise publish a digest that can never verify, and every install of
// that release would be rejected.

import { createHash } from "node:crypto";

export function sourceDigest(files) {
  const names = Object.keys(files).sort();
  const hash = createHash("sha256");
  for (const name of names) {
    const body = files[name];
    hash.update(`${Buffer.byteLength(name, "utf8")}:${name}${Buffer.byteLength(body, "utf8")}:${body}`);
  }
  return hash.digest("hex");
}
