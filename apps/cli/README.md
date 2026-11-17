# Software Factory

An AI software factory: it turns GitHub issues into reviewed, tested pull requests, with Claude Code agents for each stage and a human at the gates you choose.

## Install

```sh
npm i -g @tomek-i/software-factory
```

This puts the `factory` command on your PATH. It needs Node.js 22.12+, Git, the GitHub CLI (`gh`) logged in, and Claude Code (`claude`) logged in.

## Quick start

```sh
# in the repo you want the factory to work on
factory init --sync   # writes .factory/config.yaml and pulls in the open issues
factory issues        # lists them
factory run 42        # takes issue #42 through the pipeline
factory serve         # the local web app
```

The full documentation is in the [README on GitHub](https://github.com/tomek-i/software-factory#readme).

## License

[PolyForm Noncommercial 1.0.0](https://github.com/tomek-i/software-factory/blob/main/LICENSE): free for personal and noncommercial use.
