import { createEffect, createRoot, createSignal } from "solid-js";

/**
 * @typedef AnyWidget
 * @prop initialize {import("@anywidget/types").Initialize}
 * @prop render {import("@anywidget/types").Render}
 */

/**
 *  @typedef AnyWidgetModule
 *  @prop render {import("@anywidget/types").Render=}
 *  @prop default {AnyWidget | (() => AnyWidget | Promise<AnyWidget>)=}
 */

/**
 * @param {string} str
 * @returns {str is "https://${string}" | "http://${string}"}
 */
function is_href(str) {
	return str.startsWith("http://") || str.startsWith("https://");
}

/**
 * @param {string} href
 * @param {string} anywidget_id
 * @returns {Promise<void>}
 */
async function load_css_href(href, anywidget_id) {
	/** @type {HTMLLinkElement | null} */
	let prev = document.querySelector(`link[id='${anywidget_id}']`);

	// Adapted from https://github.com/vitejs/vite/blob/d59e1acc2efc0307488364e9f2fad528ec57f204/packages/vite/src/client/client.ts#L185-L201
	// Swaps out old styles with new, but avoids flash of unstyled content.
	// No need to await the load since we already have styles applied.
	if (prev) {
		let newLink = /** @type {HTMLLinkElement} */ (prev.cloneNode());
		newLink.href = href;
		newLink.addEventListener("load", () => prev?.remove());
		newLink.addEventListener("error", () => prev?.remove());
		prev.after(newLink);
		return;
	}

	return new Promise((resolve) => {
		let link = Object.assign(document.createElement("link"), {
			rel: "stylesheet",
			href,
			onload: resolve,
		});
		document.head.appendChild(link);
	});
}

/**
 * @param {string} css_text
 * @param {string} anywidget_id
 * @returns {void}
 */
function load_css_text(css_text, anywidget_id) {
	/** @type {HTMLStyleElement | null} */
	let prev = document.querySelector(`style[id='${anywidget_id}']`);
	if (prev) {
		// replace instead of creating a new DOM node
		prev.textContent = css_text;
		return;
	}
	let style = Object.assign(document.createElement("style"), {
		id: anywidget_id,
		type: "text/css",
	});
	style.appendChild(document.createTextNode(css_text));
	document.head.appendChild(style);
}

/**
 * @param {string | undefined} css
 * @param {string} anywidget_id
 * @returns {Promise<void>}
 */
async function load_css(css, anywidget_id) {
	if (!css || !anywidget_id) return;
	if (is_href(css)) return load_css_href(css, anywidget_id);
	return load_css_text(css, anywidget_id);
}

/**
 * @param {string} esm
 * @returns {Promise<AnyWidgetModule>}
 */
async function load_esm(esm) {
	if (is_href(esm)) {
		return import(/* webpackIgnore: true */ esm);
	}
	let url = URL.createObjectURL(new Blob([esm], { type: "text/javascript" }));
	let widget;
	try {
		widget = await import(/* webpackIgnore: true */ url);
	} catch (e) {
		console.log(e);
		throw e;
	}
	URL.revokeObjectURL(url);
	return widget;
}

function warn_render_deprecation() {
	console.warn(`\
[anywidget] Deprecation Warning. Direct export of a 'render' will likely be deprecated in the future. To migrate ...

Remove the 'export' keyword from 'render'
-----------------------------------------

export function render({ model, el }) { ... }
^^^^^^

Create a default export that returns an object with 'render'
------------------------------------------------------------

function render({ model, el }) { ... }
         ^^^^^^
export default { render }
                 ^^^^^^

To learn more, please see: https://github.com/manzt/anywidget/pull/395
`);
}

/**
 * @param {string} esm
 * @returns {Promise<AnyWidget>}
 */
async function load_widget(esm) {
	let mod = await load_esm(esm);
	if (mod.render) {
		warn_render_deprecation();
		return {
			async initialize() {},
			render: mod.render,
		};
	}
	if (!mod.default) {
		throw new Error(
			`[anywidget] module must export a default function or object.`,
		);
	}
	let widget = typeof mod.default === "function"
		? await mod.default()
		: mod.default;
	return widget;
}

/**
 * This is a trick so that we can cleanup event listeners added
 * by the user-defined function.
 */
let INITIALIZE_MARKER = Symbol("anywidget.initialize");

/**
 * @param {import("@jupyter-widgets/base").DOMWidgetModel} model
 * @param {unknown} context
 * @return {import("@anywidget/types").AnyModel}
 *
 * Prunes the view down to the minimum context necessary.
 *
 * Calls to `model.get` and `model.set` automatically add the
 * `context`, so we can gracefully unsubscribe from events
 * added by user-defined hooks.
 */
function model_proxy(model, context) {
	return {
		get: model.get.bind(model),
		set: model.set.bind(model),
		save_changes: model.save_changes.bind(model),
		send: model.send.bind(model),
		// @ts-expect-error
		on(name, callback) {
			model.on(name, callback, context);
		},
		off(name, callback) {
			model.off(name, callback, context);
		},
		widget_manager: model.widget_manager,
	};
}

export class Runtime {
	/** @type {() => void} */
	#disposer = () => {};
	/** @type {Array<() => void>} */
	#view_disposers = [];
	/** @type {import('solid-js').Accessor<AnyWidget["render"] | null>} */
	#render = () => null;

	/** @param {import("@jupyter-widgets/base").DOMWidgetModel} model */
	constructor(model) {
		this.#disposer = createRoot((dispose) => {
			let [css, set_css] = createSignal(model.get("_css"));
			model.on("change:_css", () => set_css(model.get("_css")));
			createEffect(() => {
				let id = model.get("_anywidget_id");
				console.debug(`[anywidget] css hot updated: ${id}`);
				load_css(css(), id);
			});

			/** @type {import("solid-js").Signal<string>} */
			let [esm, setEsm] = createSignal(model.get("_esm"));
			model.on("change:_esm", async () => {
				let id = model.get("_anywidget_id");
				console.debug(`[anywidget] esm hot updated: ${id}`);
				setEsm(model.get("_esm"));
			});
			let [render, set_render] = createSignal(
				/** @type {AnyWidget["render"] | null} */ (null),
			);
			/** @type {Array<() => Promise<void>>} */
			let stack = [];
			createEffect(() => {
				let new_esm = esm();
				let cleanup = stack.pop() ?? (() => Promise.resolve());
				cleanup()
					.catch((e) =>
						console.warn("[anywidget] error cleaning up load_widget.", e)
					)
					.then(() => load_widget(new_esm))
					.then(async (widget) => {
						model.off(null, null, INITIALIZE_MARKER);
						let next = await widget.initialize?.({
							model: model_proxy(model, INITIALIZE_MARKER),
						});
						set_render(() => widget.render);
						stack.push(async () => next?.());
					})
					.catch(() => stack.push(() => Promise.resolve()));
			});
			this.#render = render;
			return () => {
				dispose();
				stack.forEach((cleanup) => cleanup());
				model.off("change:_css");
				model.off("change:_esm");
			};
		});
	}

	/**
	 * @param {import("@jupyter-widgets/base").DOMWidgetView} view
	 * @returns {Promise<() => void>}
	 */
	async add_view(view) {
		let model = view.model;
		let disposer = createRoot((dispose) => {
			/** @type {Array<() => Promise<void>>} */
			let stack = [];

			// Register an effect for any time render changes.
			createEffect(() => {
				let render = this.#render();
				let cleanup = stack.pop() ?? (() => Promise.resolve());
				cleanup()
					.catch((e) =>
						console.warn("[anywidget] error cleaning up render.", e)
					)
					.then(async () => {
						model.off(null, null, view);
						view.$el.empty();
						let next = await render?.({
							model: model_proxy(model, view),
							el: view.el,
						});
						stack.push(async () => next?.());
					})
					.catch(() => stack.push(() => Promise.resolve()));
			});
			return () => {
				dispose();
				stack.forEach((cleanup) => cleanup());
			};
		});
		// Have the runtime keep track but allow the view to dispose itself.
		this.#view_disposers.push(disposer);
		return () => {
			disposer();
			this.#view_disposers = this.#view_disposers.filter((x) => x !== disposer);
		};
	}

	dispose() {
		this.#view_disposers.forEach((dispose) => dispose());
		this.#disposer();
	}
}
