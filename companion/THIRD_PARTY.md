# ChatGPT authorization attribution

`oauth.mjs` and the adapted regression tests in `../tests/oauth.test.mjs` are derived from [WillQvQ/dsh-chatgpt-plan](https://github.com/WillQvQ/dsh-chatgpt-plan), commit `7d1ce4b0e61fdaa5dca8136fb2f352834ae42b8a` (v0.1.3), under the MIT license. The copyright and license are preserved in `dsh-chatgpt-plan-LICENSE.txt`.

Changes: application name and UI wording identify 力扣伴读; storage is supplied by this application's own protected directory. This application does not load DSH, Codex, Pi or browser authentication files. The companion HTTP server and sidebar integration are separate implementations.

Official protocol references (checked 2026-10-16):

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)
- [Preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)
