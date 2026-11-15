# 35. Dashboard security model

Loopback bind; `Host` must be one of the server's own origins (DNS rebinding); `Sec-Fetch-Site`
other than `same-origin`/`none` is refused; mutations need a same-origin `Origin`, JSON content
type, and a per-process CSRF token that only the page can fetch. Bodies are capped and validated
field by field. Static files are confined to `web/dist`; artifact text is served only for paths
registered in the database, so the API can never read an arbitrary file; owner tokens are stripped
from every response. There is no authentication because the server is single-user on loopback; it
must not be bound elsewhere.
