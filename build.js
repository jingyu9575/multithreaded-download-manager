const { promises: fs, watch } = require('fs')
const path = require("path")
const child_process = require('child_process')

require('events').defaultMaxListeners = 100

const SRC = 'src'
const DIST = 'dist'

const LANG = (process.env.LANG || '').replace(/\..*/, '')
	.replace(/[^-0-9a-zA-Z_]/g, '')
const LANG_ARG = LANG ? ` --locale ${LANG} ` : ''

const BUILDERS = {
	ts: {},
	pug: {},
	cson: {
		to: 'json',
		cmd: (s, d) => `cson2json ${s} > ${d}`,
	},
	styl: {
		to: 'css',
		cmd: (s, d) => `stylus < ${s} > ${d}`
	}
}
const EXTRA_BUILD = [
	`tsc ${LANG_ARG}`,
	`pug -P -s -o ${DIST} ${SRC}`,
]
const EXTRA_WATCH = [
	`tsc -w ${LANG_ARG}`,
	`pug -w -P -s -o ${DIST} ${SRC}`,
]

const DEFAULT_MESSAGES = '_locales/en/messages.cson'

async function mkdirs(d) {
	try {
		await fs.mkdir(path.dirname(d), { recursive: true })
	} catch (error) {
		if (error.code !== 'EEXIST') throw error
	}
}

function call(cmd) {
	return new Promise((resolve, reject) => {
		const child = child_process.exec(cmd)
		child.stdout.pipe(process.stdout)
		child.stderr.pipe(process.stderr)
		child.on('error', reject)
		child.on('exit', resolve)
	})
}

async function build(s) {
	let d = path.posix.join(DIST, path.posix.relative(SRC, s))
	const ext = s.replace(/.*\./, '')
	const builder = BUILDERS[ext]
	if (!builder) {
		await mkdirs(d)
		await fs.copyFile(s, d)
		return
	} else if (builder.cmd) {
		d = `${d.slice(0, -ext.length)}${builder.to}`
		await mkdirs(d)
		await call(builder.cmd(s, d))
	}
}

async function buildMessages() {
	const d = 'typings/generated/messages.d.ts'
	await mkdirs(d)
	let content = 'interface I18nMessages {\n'
	for (const line of
		(await fs.readFile(`${SRC}/${DEFAULT_MESSAGES}`, 'utf-8')).split(/\r|\n/)) {
		const [matched, key] = line.match(/^(\w+):\s*(?:#|$)/) || []
		if (matched) content += `\t${key}: string\n`
	}
	content += '}\n'
	await fs.writeFile(d, content, 'utf-8')
}

async function listFiles(root) {
	return !(await fs.stat(root)).isDirectory() ? [root] :
		[].concat(...await Promise.all((await fs.readdir(root)).map(
			item => listFiles(path.posix.join(root, item)))))
}

process.chdir(__dirname)
process.env.PATH = './node_modules/.bin' +
	(process.platform === 'win32' ? ';' : ':') + process.env.PATH
const argv = process.argv.slice(2)

listFiles(SRC).then(async files => {
	if (argv.includes('--watch')) {
		let messagesPromise = buildMessages()
		const builds = {}
		for (const file of files) {
			builds[file] = messagesPromise.then(() => build(file))
			watch(file, {}, () => {
				if (file === `${SRC}/${DEFAULT_MESSAGES}`)
					messagesPromise = messagesPromise.then(() => buildMessages())
				builds[file] = builds[file].then(() => build(file))
			})
		}
		EXTRA_WATCH.forEach(call)
	} else /* build */ {
		await buildMessages()
		await Promise.all([...files.map(build), ...EXTRA_BUILD.map(call)])
		if (argv.includes('--xpi')) {
			process.chdir(DIST)
			await call(argv.includes('--7z') ?
				`7z a "../${DIST}.unsigned.xpi"` :
				`zip -r -FS "../${DIST}.unsigned.xpi" *`)
		}
	}
})
