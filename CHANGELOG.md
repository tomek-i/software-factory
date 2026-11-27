# Changelog

## [0.9.0](https://github.com/tomek-i/software-factory/compare/v0.8.0...v0.9.0) (2026-11-27)


### Features

* add factory audit, a claude-security scan of the default branch ([#292](https://github.com/tomek-i/software-factory/issues/292)) ([4e81845](https://github.com/tomek-i/software-factory/commit/4e818450c444310534057bbc61a7f89d022c4485))
* **core:** add the security-scan review lens ([#291](https://github.com/tomek-i/software-factory/issues/291)) ([76288c0](https://github.com/tomek-i/software-factory/commit/76288c00b057124f2b686d9b14fa5e75e66d5307))
* run security audits on a schedule, with an Audits screen ([#294](https://github.com/tomek-i/software-factory/issues/294)) ([e683d82](https://github.com/tomek-i/software-factory/commit/e683d8238cff62c3d4e9d851ffd31b6c68b8dbc6))

## [0.8.0](https://github.com/tomek-i/software-factory/compare/v0.7.0...v0.8.0) (2026-11-23)


### ⚠ BREAKING CHANGES

* **work:** work on the current project only unless --all ([#279](https://github.com/tomek-i/software-factory/issues/279))

### Features

* **merge:** answer and resolve the factory's review threads before merging ([#282](https://github.com/tomek-i/software-factory/issues/282)) ([1863db0](https://github.com/tomek-i/software-factory/commit/1863db002ddb5fe23c02351e1f8b95ca3083a26a)), closes [#250](https://github.com/tomek-i/software-factory/issues/250)
* **scheduler:** say when the daily start limit holds the queue back ([#281](https://github.com/tomek-i/software-factory/issues/281)) ([790a029](https://github.com/tomek-i/software-factory/commit/790a02997b2f6ff63a545ff0425d12a555e6d4c3)), closes [#249](https://github.com/tomek-i/software-factory/issues/249)
* **server:** read and save a project's settings over the API ([#243](https://github.com/tomek-i/software-factory/issues/243)) ([cb6ffea](https://github.com/tomek-i/software-factory/commit/cb6ffeab3fd198242720085239d16663d64b783e))
* **web:** see and change a project's settings on a Settings screen ([#244](https://github.com/tomek-i/software-factory/issues/244)) ([73adc1d](https://github.com/tomek-i/software-factory/commit/73adc1d4513ca86bc07752d684c78c9c523aad66))
* **web:** show and answer the questions of a run waiting for its author ([#283](https://github.com/tomek-i/software-factory/issues/283)) ([ee788e4](https://github.com/tomek-i/software-factory/commit/ee788e49ea156d5e1761c3a9d33ffe630bf8fcaf))
* **web:** warn in the header and Inbox while the start limit holds the queue ([#284](https://github.com/tomek-i/software-factory/issues/284)) ([c94fc8e](https://github.com/tomek-i/software-factory/commit/c94fc8e32e3e75f4ad9275c9da38d3894a8306dd))
* **work:** work on the current project only unless --all ([#279](https://github.com/tomek-i/software-factory/issues/279)) ([0d40588](https://github.com/tomek-i/software-factory/commit/0d40588ad9cd1d05b02e9abe9f9fb1a0d46ea129))


### Bug Fixes

* **cleanup:** clean up hand-merged runs on sync and say what cleanup leaves ([#238](https://github.com/tomek-i/software-factory/issues/238)) ([0048404](https://github.com/tomek-i/software-factory/commit/00484045125198970fce15f6072348cbde41994d)), closes [#217](https://github.com/tomek-i/software-factory/issues/217)
* **cli:** name a repo with a factory database that the project list misses ([#280](https://github.com/tomek-i/software-factory/issues/280)) ([75c68e7](https://github.com/tomek-i/software-factory/commit/75c68e75cedf0a3f59ebc0f7c3ed6b910a8e0751)), closes [#142](https://github.com/tomek-i/software-factory/issues/142)
* **core:** start only package manager scripts through cmd ([#285](https://github.com/tomek-i/software-factory/issues/285)) ([d282010](https://github.com/tomek-i/software-factory/commit/d2820107a612a587d6d04a21a9427eda9f369400))
* **new:** keep --queue in the retry hints ([#240](https://github.com/tomek-i/software-factory/issues/240)) ([e393b9e](https://github.com/tomek-i/software-factory/commit/e393b9efa93c6d8d52d6338bc6550bbfd426b4f3))
* **snapshot:** address the snapshot review notes ([#239](https://github.com/tomek-i/software-factory/issues/239)) ([cad3afe](https://github.com/tomek-i/software-factory/commit/cad3afe5fed150c40bb947d1aa9948cc5dc041b5))
* **web:** address the run details review notes ([#241](https://github.com/tomek-i/software-factory/issues/241)) ([3ae463e](https://github.com/tomek-i/software-factory/commit/3ae463e2565e2fab6ed506586229417aaa2bb4aa)), closes [#179](https://github.com/tomek-i/software-factory/issues/179)

## [0.7.0](https://github.com/tomek-i/software-factory/compare/v0.6.0...v0.7.0) (2026-11-17)


### Features

* **cli:** add --sync, --name, --labels and --dry-run to factory init ([#234](https://github.com/tomek-i/software-factory/issues/234)) ([0f5c788](https://github.com/tomek-i/software-factory/commit/0f5c788eff9bacc3e0b5e10aacebe1a69970470b))
* **cli:** colour errors, help and the plain commands ([#228](https://github.com/tomek-i/software-factory/issues/228)) ([f67e062](https://github.com/tomek-i/software-factory/commit/f67e06209c4a81614119129c3f75ca987fd54c85))
* **reconcile:** finish or flag runs whose issue was closed on github ([#233](https://github.com/tomek-i/software-factory/issues/233)) ([4bbeaa8](https://github.com/tomek-i/software-factory/commit/4bbeaa80772df9a2589d9447cf5647fd284d8b74))
* **web:** show the PR, its checks and the reviews on a merge-gate card ([#197](https://github.com/tomek-i/software-factory/issues/197)) ([ca2d8c2](https://github.com/tomek-i/software-factory/commit/ca2d8c2329f91f5584cde2d9e9503d47bff4ee47)), closes [#180](https://github.com/tomek-i/software-factory/issues/180)


### Bug Fixes

* **core:** refuse the real data folder when tests run without the setup file ([#232](https://github.com/tomek-i/software-factory/issues/232)) ([d091895](https://github.com/tomek-i/software-factory/commit/d09189575a8dd8b0f9293f5d350465ce203fd6a4))


### Performance

* **core:** make fewer git calls per pipeline step ([#236](https://github.com/tomek-i/software-factory/issues/236)) ([0cbc7ba](https://github.com/tomek-i/software-factory/commit/0cbc7ba03c3f7650598208d7ca0f5fe77b6885d8)), closes [#159](https://github.com/tomek-i/software-factory/issues/159)


### Documentation

* turn the readme into a short landing page ([#235](https://github.com/tomek-i/software-factory/issues/235)) ([81a355a](https://github.com/tomek-i/software-factory/commit/81a355a3840e140780dc24f7a232340d976a3825))

## [0.6.0](https://github.com/tomek-i/software-factory/compare/v0.5.0...v0.6.0) (2026-11-17)


### Features

* **cli:** add factory upgrade ([#223](https://github.com/tomek-i/software-factory/issues/223)) ([688929b](https://github.com/tomek-i/software-factory/commit/688929bcb6b697c547e02de73e577e93d671884f))
* **merge:** hold the merge on open review threads and failed checks ([#221](https://github.com/tomek-i/software-factory/issues/221)) ([1346d1e](https://github.com/tomek-i/software-factory/commit/1346d1e16b6a2a3a4a87142a6d014b87afc6eb48)), closes [#173](https://github.com/tomek-i/software-factory/issues/173)
* **prompts:** grade weakened protections as at least major ([#220](https://github.com/tomek-i/software-factory/issues/220)) ([5c6640e](https://github.com/tomek-i/software-factory/commit/5c6640e38807d5a88ac3873435b0b7bd5f829cc2)), closes [#177](https://github.com/tomek-i/software-factory/issues/177)


### Bug Fixes

* **cli:** compare real paths when warning about an export inside the repo ([#226](https://github.com/tomek-i/software-factory/issues/226)) ([3b581f1](https://github.com/tomek-i/software-factory/commit/3b581f1653468eb8850013266f4a84d8de21df69))
* **import:** let github, not the snapshot file, settle trust and issue fields ([#222](https://github.com/tomek-i/software-factory/issues/222)) ([da9acbc](https://github.com/tomek-i/software-factory/commit/da9acbc3b87b48b0feaf0b838b9718aa0799b254)), closes [#178](https://github.com/tomek-i/software-factory/issues/178)
* resolve the code scanning and dependabot findings on main ([#219](https://github.com/tomek-i/software-factory/issues/219)) ([45d5215](https://github.com/tomek-i/software-factory/commit/45d52159a6fc05e6b638a8fda4706dea11a05e64)), closes [#215](https://github.com/tomek-i/software-factory/issues/215)

## [0.5.0](https://github.com/tomek-i/software-factory/compare/v0.4.0...v0.5.0) (2026-11-17)


### Features

* **agents:** give agents the default branch's CLAUDE.md ([#149](https://github.com/tomek-i/software-factory/issues/149)) ([85462dd](https://github.com/tomek-i/software-factory/commit/85462dd0999a030e2faa35ebb49cd3d690578f4d)), closes [#127](https://github.com/tomek-i/software-factory/issues/127)
* **core:** let the issue writer pick labels the repository has ([#211](https://github.com/tomek-i/software-factory/issues/211)) ([2347491](https://github.com/tomek-i/software-factory/commit/234749189143308596a3683d319931cb55984176))
* **core:** put the refined spec in the body of the factory's own issues ([#209](https://github.com/tomek-i/software-factory/issues/209)) ([3f1a8d4](https://github.com/tomek-i/software-factory/commit/3f1a8d42d2c75291566ff1804d4ca6198a2dcdc9))
* **core:** retry failed checks and park runs whose gate only timed out ([#214](https://github.com/tomek-i/software-factory/issues/214)) ([293d48b](https://github.com/tomek-i/software-factory/commit/293d48be0382d2bfdcb7cd44abc751ad530b3cf0))
* **merge:** read checks before the merge gate and count re-syncs apart ([#194](https://github.com/tomek-i/software-factory/issues/194)) ([35e04f6](https://github.com/tomek-i/software-factory/commit/35e04f6ac3d75017f21a0abf2c10490e83b1ccc4)), closes [#192](https://github.com/tomek-i/software-factory/issues/192)
* **review:** check each acceptance criterion and tick met ones after merge ([#199](https://github.com/tomek-i/software-factory/issues/199)) ([02bd2c6](https://github.com/tomek-i/software-factory/commit/02bd2c6063889f39ec2dfcebc4e4be3793e6078a)), closes [#190](https://github.com/tomek-i/software-factory/issues/190)
* **review:** post review notes as an inline pr review ([#206](https://github.com/tomek-i/software-factory/issues/206)) ([d0543df](https://github.com/tomek-i/software-factory/commit/d0543df0d41ed0b2fea0ff03e69f0fa0a0a9fde9))
* **web:** send a waiting run back to a stage and dismiss false-positive alerts ([#195](https://github.com/tomek-i/software-factory/issues/195)) ([0ba567b](https://github.com/tomek-i/software-factory/commit/0ba567b75c8cf431d35d1bfbf1eec49119fbd0dc)), closes [#191](https://github.com/tomek-i/software-factory/issues/191)

## [0.4.0](https://github.com/tomek-i/software-factory/compare/v0.3.1...v0.4.0) (2026-11-16)


### Features

* **cli:** add factory export and import to move local state between machines ([#167](https://github.com/tomek-i/software-factory/issues/167)) ([aa0c1e3](https://github.com/tomek-i/software-factory/commit/aa0c1e3892c37f4e9257b5718ffb234b02129582)), closes [#151](https://github.com/tomek-i/software-factory/issues/151)
* **cli:** make queuing opt-in for issues created by factory new ([#165](https://github.com/tomek-i/software-factory/issues/165)) ([ebf07e8](https://github.com/tomek-i/software-factory/commit/ebf07e87a91f566f49127d145af6bf0e7f958e8f)), closes [#146](https://github.com/tomek-i/software-factory/issues/146)
* **web:** add a new issue screen over the issue writer ([#172](https://github.com/tomek-i/software-factory/issues/172)) ([a65eab3](https://github.com/tomek-i/software-factory/commit/a65eab364533ed41a0a2303eb53072fc879818ad)), closes [#135](https://github.com/tomek-i/software-factory/issues/135)
* **web:** open a run's details from the inbox and runs screens ([#168](https://github.com/tomek-i/software-factory/issues/168)) ([2affeb4](https://github.com/tomek-i/software-factory/commit/2affeb4f4f2a388a08e3920bfa34848c23a3678d)), closes [#144](https://github.com/tomek-i/software-factory/issues/144)
* **web:** show labels in the backlog and filter by label ([#174](https://github.com/tomek-i/software-factory/issues/174)) ([c38c67b](https://github.com/tomek-i/software-factory/commit/c38c67bda29af94b8f29d2f199f92cdfb02e0f96)), closes [#147](https://github.com/tomek-i/software-factory/issues/147)
* **web:** use more width on large screens ([#171](https://github.com/tomek-i/software-factory/issues/171)) ([8e892ed](https://github.com/tomek-i/software-factory/commit/8e892edb17003c577fe778dda1c71e94c85cf0ac)), closes [#145](https://github.com/tomek-i/software-factory/issues/145)


### Refactoring

* **core:** split the pipeline driver into one module per stage ([#170](https://github.com/tomek-i/software-factory/issues/170)) ([bacebc5](https://github.com/tomek-i/software-factory/commit/bacebc54112dfbadfe3bde71bab29e408799a466)), closes [#65](https://github.com/tomek-i/software-factory/issues/65)


### Documentation

* split the readme into short docs with one fact per line ([#169](https://github.com/tomek-i/software-factory/issues/169)) ([20daafd](https://github.com/tomek-i/software-factory/commit/20daafd7de51679ca9d7ddb97739360ecfc64b6c)), closes [#67](https://github.com/tomek-i/software-factory/issues/67)

## [0.3.1](https://github.com/tomek-i/software-factory/compare/v0.3.0...v0.3.1) (2026-11-16)


### Bug Fixes

* **core:** show agent activity paths relative to the worktree or repo ([#150](https://github.com/tomek-i/software-factory/issues/150)) ([5a76b71](https://github.com/tomek-i/software-factory/commit/5a76b71b864dcf338bfd891c96c1c20cb78b0f2e))

## [0.3.0](https://github.com/tomek-i/software-factory/compare/v0.2.0...v0.3.0) (2026-11-16)


### Features

* publish the cli to npm as @tomek-i/software-factory ([#155](https://github.com/tomek-i/software-factory/issues/155)) ([d97c7c3](https://github.com/tomek-i/software-factory/commit/d97c7c337e332ca7a4abd5ab5e36183b32440bee))

## [0.2.0](https://github.com/tomek-i/software-factory/compare/v0.1.1...v0.2.0) (2026-11-16)


### Features

* **config:** recommended models as defaults, add factory config reset ([#153](https://github.com/tomek-i/software-factory/issues/153)) ([eeb314a](https://github.com/tomek-i/software-factory/commit/eeb314a253128d88e7e6cd83c0368ebf3681d92f))


### Performance

* **builder:** leave the full test suite to the gate and run slow tests in parallel ([#156](https://github.com/tomek-i/software-factory/issues/156)) ([d8551f1](https://github.com/tomek-i/software-factory/commit/d8551f1ab83799f25cddc2549c912e58ef0cee70))

## [0.1.1](https://github.com/tomek-i/software-factory/compare/v0.1.0...v0.1.1) (2026-11-16)


### Documentation

* install factory as a global command ([#140](https://github.com/tomek-i/software-factory/issues/140)) ([ed0d0fb](https://github.com/tomek-i/software-factory/commit/ed0d0fbe97d42ff2dc6acab51c8b8fc975dbc1b5))

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
