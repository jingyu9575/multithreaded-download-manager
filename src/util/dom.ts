export function importTemplateElement(template: HTMLTemplateElement | string) {
	return importTemplate(template).firstElementChild!
}

export function importTemplate(template: HTMLTemplateElement | string) {
	if (typeof template === 'string')
		template = document.getElementById(template) as HTMLTemplateElement
	return document.importNode(template.content, true)
}

export function defineBooleanAttribute(T: { prototype: HTMLElement }, attr: string) {
	Object.defineProperty(T.prototype, attr, {
		get(this: HTMLElement) { return this.hasAttribute(attr) },
		set(this: HTMLElement, value: boolean) {
			value ? this.setAttribute(attr, '') : this.removeAttribute(attr)
		},
	})
}