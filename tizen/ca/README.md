Samsung's public Tizen developer CA certificates (not secrets). They form the
chain inside the `.p12` files that `scripts/tizen-samsung-cert.mjs` writes:

- `vd_tizen_dev_author_ca.cer`: Samsung VD Author CA
- `vd_tizen_dev_public2.crt`: VD DEVELOPER Public CA Class (public distributor level)

They're the same files Samsung's Certificate Extension installs, copied from
Apps2Samsung (https://github.com/Apps2Samsung/Apps2Samsung, MIT).
