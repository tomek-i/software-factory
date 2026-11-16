# Changelog

## 0.1.0 (2026-11-15)


### Features

* add a per-user list of the projects the factory manages ([#137](https://github.com/tomek-i/software-factory/issues/137)) ([feed56f](https://github.com/tomek-i/software-factory/commit/feed56f540d2d2a9d6792d5bcc2d7f6c8da067bf)), closes [#132](https://github.com/tomek-i/software-factory/issues/132)
* add web mode with factory serve ([#139](https://github.com/tomek-i/software-factory/issues/139)) ([d6e67ed](https://github.com/tomek-i/software-factory/commit/d6e67ed8d4869aac306a93efcee05ec65cf9c687)), closes [#24](https://github.com/tomek-i/software-factory/issues/24) [#25](https://github.com/tomek-i/software-factory/issues/25) [#26](https://github.com/tomek-i/software-factory/issues/26) [#27](https://github.com/tomek-i/software-factory/issues/27) [#29](https://github.com/tomek-i/software-factory/issues/29) [#134](https://github.com/tomek-i/software-factory/issues/134)
* **capture:** attach pr screenshots and videos as github attachments ([#109](https://github.com/tomek-i/software-factory/issues/109)) ([33cc715](https://github.com/tomek-i/software-factory/commit/33cc715a13d1f7906c49b58c41d4a93f885993a8)), closes [#87](https://github.com/tomek-i/software-factory/issues/87)
* clean up a finished run's worktree and branches ([#110](https://github.com/tomek-i/software-factory/issues/110)) ([2e76265](https://github.com/tomek-i/software-factory/commit/2e76265b5d1bb745df578b36a9bb0cb93d653abd)), closes [#86](https://github.com/tomek-i/software-factory/issues/86)
* **cli:** run the factory on itself only from a pinned copy ([#111](https://github.com/tomek-i/software-factory/issues/111)) ([d98e485](https://github.com/tomek-i/software-factory/commit/d98e4850b5431b433439bd5b97c84bb59ae0a93d))
* work through every project's queue with factory work ([#138](https://github.com/tomek-i/software-factory/issues/138)) ([7c9bbb9](https://github.com/tomek-i/software-factory/commit/7c9bbb9e3b3c6c2e46411c49e55ad4479de6a360)), closes [#18](https://github.com/tomek-i/software-factory/issues/18) [#19](https://github.com/tomek-i/software-factory/issues/19) [#20](https://github.com/tomek-i/software-factory/issues/20)


### Bug Fixes

* **agents:** keep the user's github login away from agents ([#130](https://github.com/tomek-i/software-factory/issues/130)) ([5fce134](https://github.com/tomek-i/software-factory/commit/5fce1342e3d1d10415adb965aa916adae40a548f)), closes [#129](https://github.com/tomek-i/software-factory/issues/129)
* **capture:** keep local paths out of the errors published to the pr ([#120](https://github.com/tomek-i/software-factory/issues/120)) ([e554405](https://github.com/tomek-i/software-factory/commit/e5544051f3568f6e69d30ae4c50048dd3a04de1f)), closes [#114](https://github.com/tomek-i/software-factory/issues/114)
* **capture:** redact git bash and long-path forms of windows paths ([#125](https://github.com/tomek-i/software-factory/issues/125)) ([614a406](https://github.com/tomek-i/software-factory/commit/614a40608d69183fca453b6441ae615cf7e6cc7a)), closes [#123](https://github.com/tomek-i/software-factory/issues/123)
* **capture:** respect app.narrate when loading playwright ([#112](https://github.com/tomek-i/software-factory/issues/112)) ([d5b498b](https://github.com/tomek-i/software-factory/commit/d5b498b00bb537e6fdb3bb3161c3b98831c597c3)), closes [#89](https://github.com/tomek-i/software-factory/issues/89)
* **cleanup:** count a remote branch github already deleted as removed ([#124](https://github.com/tomek-i/software-factory/issues/124)) ([4d273ae](https://github.com/tomek-i/software-factory/commit/4d273ae00d83a9147abea861257294f1a22f29d5)), closes [#122](https://github.com/tomek-i/software-factory/issues/122)
* **cleanup:** report only what was removed and retry a locked worktree ([#118](https://github.com/tomek-i/software-factory/issues/118)) ([77ff50d](https://github.com/tomek-i/software-factory/commit/77ff50d61f51e36e30aec5ea880f6ac6d823580a)), closes [#117](https://github.com/tomek-i/software-factory/issues/117)
* **deps:** override minimatch to 11.0.1+ for GHSA-g3hv-75wg-m249 ([#108](https://github.com/tomek-i/software-factory/issues/108)) ([1b17969](https://github.com/tomek-i/software-factory/commit/1b17969ceead3c420430b34c0565efb4283f7ecc))


### Refactoring

* **core:** move run actions from the cli into a service layer ([#136](https://github.com/tomek-i/software-factory/issues/136)) ([4803800](https://github.com/tomek-i/software-factory/commit/4803800d8639a1259e662f964a209cf61148a37a)), closes [#131](https://github.com/tomek-i/software-factory/issues/131)


### Documentation

* add a claude.md with an architecture map and security checklist ([#126](https://github.com/tomek-i/software-factory/issues/126)) ([85b4fe8](https://github.com/tomek-i/software-factory/commit/85b4fe8724179c5215e539cd46836307a32c1c41)), closes [#66](https://github.com/tomek-i/software-factory/issues/66)
* **capture:** say when the narrate plugin's playwright saves an install ([#116](https://github.com/tomek-i/software-factory/issues/116)) ([60792c0](https://github.com/tomek-i/software-factory/commit/60792c0c65973d2f7604901eb8cc9fdd5edd1eee)), closes [#113](https://github.com/tomek-i/software-factory/issues/113)
* document main protection and repo settings ([#106](https://github.com/tomek-i/software-factory/issues/106)) ([7ded686](https://github.com/tomek-i/software-factory/commit/7ded686cd9a0c4c64cb2a1e11fb9ea0863e82fe5))
