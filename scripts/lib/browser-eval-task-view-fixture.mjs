export function taskViewFixture() {
	return {
		body: `<nav aria-label="Primary"><a href="/task-view">Invoice workspace</a></nav>
		<section aria-label="Unrelated controls">${Array.from({ length: 90 }, (_, i) => `<button>Unrelated ${i}</button>`).join("")}</section>
		<form aria-label="INV-2048"><h2>INV-2048</h2>
		<fieldset><legend>Notes</legend><label>Note <input id="target-note" value="Draft" aria-describedby="note-error"></label></fieldset>
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

export function progressiveTaskFixture() {
	return {
		body: `<form id="packet-form" aria-label="INV-7777"><h2>INV-7777</h2>
		<fieldset><legend>Notes</legend><label for="packet-note">Note</label><input id="packet-note" value="Draft packet" aria-describedby="packet-error"></fieldset>
		${Array.from({ length: 180 }, (_, i) => `<label>Optional ${i}<input value="Value ${i}"></label>`).join("")}</form>
		<div role="group" aria-label="External actions"><button id="packet-save" form="packet-form" type="button">Save packet</button></div>
		<form id="other-form" aria-label="INV-8888"><label>Other note<input id="other-packet-note" value="Other draft"></label><button id="other-packet-save" type="button">Save packet</button></form>
		<p id="packet-error">Note requires review</p><p role="status" id="packet-status">Unsaved</p>`,
		script: `window.packetSaves = 0; window.otherPacketSaves = 0;
		document.querySelector('#packet-save').onclick = () => { window.packetSaves++; window.packetSavedValue = document.querySelector('#packet-note').value; document.querySelector('#packet-status').textContent = 'Saved packet'; };
		document.querySelector('#other-packet-save').onclick = () => { window.otherPacketSaves++; };`,
	};
}
