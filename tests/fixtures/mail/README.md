# Mail test fixtures

Self-signed certificates and private keys for `localhost` and `127.0.0.1`, valid until 2126, used
only by the in-process fake SMTPS server in `tests/mail-server.ts`. They are test-only and protect
nothing: `cert.pem`/`key.pem` is the server the tests trust, `untrusted-cert.pem`/`untrusted-key.pem`
a server they must refuse. Never use them anywhere else.
