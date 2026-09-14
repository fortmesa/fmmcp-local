# How document tools work in this client

This server is a **relay**. Tools published by the FortMesa MCP endpoint are forwarded with their
JSON Schemas verbatim (`src/local-mcp/proxy.ts`); this side owns zero remote schemas. Documents are
the one exception, and only partly so. **Local**: `grc_documents_read method=download` and `grc_documents_write method=upload`. These move
bytes between your filesystem and the FortMesa API, which a remote server cannot do for you.
`download` writes to the `filePath` you give it; `upload` reads `filePath`, derives the stored name
from its basename, and POSTs it as multipart. **Relayed**: everything else, `list` / `get` / `generate` / `download_url` / `upload_url` /
`upload_status` / `update` / delete included. Their behaviour and their descriptions come from the
server, so they can change without a client release.
**Two upload styles, and when each applies.** `upload` is the one to prefer — one call, bytes moved
for you. `upload_url` + `upload_status` is the three-step alternative: ask for a URL, PUT the bytes
straight to object storage yourself, then poll until the document reports complete. Use it for large
files or when something else is doing the transfer. A revision of an existing file merges onto the
existing document, so `upload_status` may answer with a **different** document id than the one you
polled — follow it rather than treating it as an error.

**URLs are time-limited.** `download_url` and `upload_url` return a signed URL valid for 60 minutes,
fetched with an ordinary HTTP client — no object-storage credentials and no special networking. They
are not single-use; treat one as a bearer credential and do not log or share it.

**`downloadedAt` means "a download URL was last issued for this document"** — not that anyone
fetched the bytes. The server cannot observe the object fetch itself.
