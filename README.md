# ampi

Experimental [Amp](https://ampcode.com) SDK provider bridge for [Pi](https://pi.dev).

## What it does

- registers an `amp` provider inside `pi`
- exposes three Amp-backed models: `amp/smart`, `amp/rush`, and `amp/deep`
- forwards each `pi` turn to the Amp SDK headlessly
- lets Amp run with its own built-in tools
- renders Amp tool activity back into `pi` as text notices

## Install

Install package into `pi`:

```bash
pi install https://github.com/tmm/ampi
```

Authenticate Amp in one of the normal ways:

```bash
amp login
```

or:

```bash
export AMP_API_KEY=sgamp_...
```

To try it without installing, you can also launch `pi` with the extension directly:

```bash
pi -e https://github.com/tmm/ampi
```

## Usage

Inside `pi`, you can switch to one of the Amp-backed models:

```text
/model amp/smart
```

You can also use:

```text
/model amp/rush
/model amp/deep
```

If the normal `/model` picker is scoped to a smaller model set, press `Tab` to switch from `scoped` to `all`.

## Development

```bash
pnpm install    # install deps
pnpm typecheck  # check types
pi -e ampi.ts   # run extension in dev
```

## License

MIT
