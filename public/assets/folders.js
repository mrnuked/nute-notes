export function renameFolder(vault, id, name) {
  const folder = vault.folders.find(item => item.id === id);
  if (!folder || id === 'notes') throw new Error('Основную папку нельзя переименовать.');
  const value = name.trim();
  if (!value || value.length > 120) throw new Error('Название должно содержать от 1 до 120 символов.');
  folder.name = value;
}
export function removeFolder(vault, id) {
  if (id === 'notes' || !vault.folders.some(folder => folder.id === id)) throw new Error('Эту папку нельзя удалить.');
  // Include trashed notes so restore never points to a removed folder.
  for (const note of vault.notes) if (note.folder === id) note.folder = 'notes';
  vault.folders = vault.folders.filter(folder => folder.id !== id);
}
