'use strict';
const field = document.getElementById('origin'), error = document.getElementById('error'), button = document.getElementById('connect');
window.ServerPicker.info().then(info => { field.value = info.origin; field.focus(); field.select(); }).catch(e => { error.textContent = e.message; });
document.getElementById('server-form').addEventListener('submit', async event => {
  event.preventDefault(); button.disabled = true; error.textContent = '';
  try { const result = await window.ServerPicker.select(field.value); if (result?.error) error.textContent = result.error; }
  catch (e) { error.textContent = e.message; }
  finally { button.disabled = false; }
});
