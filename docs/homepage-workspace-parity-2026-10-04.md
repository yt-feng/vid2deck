# Localized homepages and English workspace parity

Application source: `b9b06b8ae5b84107f88e033a3e71344dbbed15a5`.
Production deployment: `dpl_CqHF7HZ86NB8yoXxrNQbZZwJCKtN`, READY and aliased to https://vid2ppt.com and https://www.vid2ppt.com.
Deployment URL: https://vid2deck-fzl31zzxg-ys-projects-5fb6bad4.vercel.app

## Customer experience

Chinese and English use the same welcome-page template and styling. The root website now opens the localized welcome page; the start, workspace and account routes still open the complete application. The welcome page retains the product preview, benefits, three steps and primary actions. The former technical/payment FAQ and Chinese-workspace warning are removed. A compact privacy link replaces the technical explanation on the homepage. All 33 marketing dictionaries carry the updated benefit and privacy copy.

The English application uses the existing Chinese workspace DOM, control IDs, CSS, event handlers, processing functions, quotas and request protocols. An explicit translation helper localizes authored copy before inserting dynamic values. The 861-entry dictionary covers static controls, editing tools, dialogs, progress, errors, account and quota feedback, transcription, AI notes, image PPT, PDF cleanup, and HTML/Markdown export chrome. Filenames, usernames, OCR text, transcripts and generated notes remain unchanged. Fresh English sessions default generated output to English; saved output preferences take priority. Short Studio and Recognize text labels fit the existing controls.

Privacy and terms document actual data flows, including necessary upload/transmission for selected online features and purpose-limited content authorization. Chinese policies remain available, and English privacy, terms and refund policies use the same layout and anchors. Other selected site languages explicitly identify the English policy fallback. Homepage copy makes no fabricated cloud-processing or blanket no-upload claim.

## Validation

- Full local frontend suite: 144 passing tests. Production build passed. The final two label edits also passed the 7 focused language tests and a fresh build.
- Final production build: 84 backend tests and 144 frontend tests passed, 228 total; build completed successfully.
- Earlier full asset verification matched 17 public/build resources. Final verification matched root HTML and all three changed JavaScript chunks exactly, including lazy export modules; unchanged public/CSS checks retain their earlier deployment and source provenance in the JSON.
- Production browser: Chinese root redirects to the new Chinese welcome page, product preview remains, technical FAQ is absent, and the compact privacy entry is present. Chinese and English desktop views have no horizontal overflow.
- English sample: reading, page reordering, crop application and adding/editing a text box were exercised. A 3-page PPTX was generated; final English visible UI has no Chinese text and no warning/error console entries. Chinese sample editing controls remain available.
- English privacy page rendered the translated content-processing explanation and preserved language/anchor links.
- Generated HTML/Markdown structure and user-content preservation are tested. The in-app browser did not expose a download event for the local HTML-note check; the application reported successful generation, but a downloaded file was not retrieved through that event.
- The viewport override did not change the hidden browser's actual 1280px viewport, so this run does not claim a new mobile browser acceptance. The override was reset.
- No payment was submitted and no new paid entitlement was claimed.

Evidence: `homepage-workspace-parity-live-2026-10-04.json`, `homepage-workspace-parity-browser-2026-10-04.json`, `payment-qa/chinese-welcome-live-2026-10-04.png`, `payment-qa/english-workspace-live-2026-10-04.png`.
