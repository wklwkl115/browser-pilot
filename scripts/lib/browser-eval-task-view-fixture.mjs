export function taskViewFixture() {
	return {
		body: `<nav aria-label="Primary"><a href="/task-view">Invoice workspace</a></nav>
		<section aria-label="Unrelated controls">${Array.from({ length: 90 }, (_, i) => `<button>Unrelated ${i}</button>`).join("")}</section>
		<form aria-label="INV-2048"><h2>INV-2048</h2>
		<label>Note <input id="target-note" value="Draft" aria-describedby="note-error"></label>
		<button type="button" id="target-save">Save</button></form>
		<form aria-label="INV-2099"><h2>INV-2099</h2>
		<label>Note <input id="other-note" value="Other record"></label>
		<button type="button" id="other-save">Save</button></form>
		<p role="alert" id="note-error">Note requires review</p><p role="status" id="save-status">Unsaved</p>`,
		script: `window.targetSaves = 0; window.otherSaves = 0;
		document.querySelector('#target-save').onclick = () => {
			window.targetSaves++; window.savedNote = document.querySelector('#target-note').value;
			document.querySelector('#save-status').textContent = 'Saved locally';
		};
		document.querySelector('#other-save').onclick = () => { window.otherSaves++; };`,
	};
}
