const { promises: fs, watch } = require('fs')
const path = require("path")
const { exec } = require('child_process')

require('events').defaultMaxListeners = 100

const s_ = 'src'
const d_ = 'dist'

const lang = (process.env.LANG || '').replace(/\..*/, '')
	.replace(/[^-0-9a-zA-Z_]/g, '')
const tscLangArg = lang ? ` --locale ${lang} ` : ''

const builders = {
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
const extraCmds = [
	`tsc ${tscLangArg}`,
	`pug -P -s -o ${d_} ${s_}`,
]
const extraWatchCmds = [
	`tsc -w ${tscLangArg}`,
	`pug -w -P -s -o ${d_} ${s_}`,
]
const xpiCmd = `zip -r -FS "../${d_}.unsigned.xpi" *`

const messageCSON = '_locales/en/messages.cson'

async function makeParentDir(d) {
	try {
		await fs.mkdir(path.dirname(d), { recursive: true })
	} catch (error) {
		if (error.code !== 'EEXIST') throw error
	}
}

function execPromise(cmd) {
	return new Promise((resolve, reject) => {
		const child = exec(cmd)
		child.stdout.pipe(process.stdout)
		child.stderr.pipe(process.stderr)
		child.on('error', reject)
		child.on('exit', resolve)
	})
}

async function build(s) {
	let d = path.posix.join(d_, path.posix.relative(s_, s))
	const ext = s.replace(/.*\./, '')
	const builder = builders[ext]
	if (!builder) {
		await makeParentDir(d)
		await fs.copyFile(s, d)
		return
	} else if (!builder.cmd) {
		return
	}
	d = `${d.slice(0, -ext.length)}${builder.to}`
	await makeParentDir(d)
	await execPromise(builder.cmd(s, d))
}

async function buildMessage() {
	const d = 'typings/generated/messages.d.ts'
	await makeParentDir(d)
	let content = 'interface I18nMessages {\n'
	for (const line of
		(await fs.readFile(`${s_}/${messageCSON}`, 'utf-8')).split(/\r|\n/)) {
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

listFiles(s_).then(async files => {
	if (argv.includes('--watch')) {
		let messageBuild = buildMessage()
		const builds = {}
		for (const file of files) {
			builds[file] = messageBuild.then(() => build(file))
			watch(file, {}, () => {
				if (file === `${s_}/${messageCSON}`)
					messageBuild = messageBuild.then(() => buildMessage())
				builds[file] = builds[file].then(() => build(file))
			})
		}
		extraWatchCmds.forEach(execPromise)
	} else {
		await buildMessage()
		await Promise.all([
			...files.map(build),
			...extraCmds.map(execPromise),
		])
		if (argv.includes('--xpi')) {
			process.chdir(d_)
			await execPromise(xpiCmd)
		}
	}
})
