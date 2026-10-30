# Third-party components

This plugin is independently implemented. ZotSeek and other Zotero plugins are research references, not dependencies or source-code bases.

- Transformers.js 3.8.1, Hugging Face — Apache-2.0. Browser runtime is bundled. https://github.com/huggingface/transformers.js
- ONNX Runtime Web / Common, Microsoft — MIT. WASM and JavaScript runtime is bundled through Transformers.js. https://github.com/microsoft/onnxruntime
- Lucide — ISC, with some Feather-derived icons under MIT. License is included. https://lucide.dev/license
- parse5 — MIT. https://github.com/inikulin/parse5
- entities — BSD-2-Clause. https://github.com/fb55/entities

Build and test tools (esbuild, TypeScript, fflate, Playwright) are development dependencies; Node.js and these tools are not required by plugin users. The XPI archive is produced using fflate (MIT).

Model weights are downloaded separately, not included in the XPI. See the original model cards and pinned revisions in src/models.ts:

- Qwen3-Embedding-0.6B ONNX: https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX — Apache-2.0.
- Multilingual E5-small ONNX: https://huggingface.co/Xenova/multilingual-e5-small — MIT.

MinerU is a separately operated cloud service, accessed using a user-configured credential. Its terms and privacy rules apply to uploaded PDFs. Zotero and Office/WPS remain separately licensed applications.
