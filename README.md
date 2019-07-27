[![Mozilla Add-on](https://img.shields.io/amo/v/multithreaded-download-manager.svg?style=flat-square)](https://addons.mozilla.org/firefox/addon/multithreaded-download-manager/) [![Mozilla Add-on](https://img.shields.io/amo/d/multithreaded-download-manager.svg?style=flat-square)](https://addons.mozilla.org/firefox/addon/multithreaded-download-manager/)

# Multithreaded Download Manager

Download manager extension for Firefox, with multithreading support.

## Build

Install the dependencies:

```sh
npm install --only=prod
```

The globally installed build tools can be used, found by `$PATH`. It is also possible to install the packages locally:

```sh
npm install --only=dev
```

Run the build script to generate the unpacked extension in `dist`:

```sh
node build
```

Create unsigned XPI release: (requires the `zip` command)

```bash
node build --xpi
```