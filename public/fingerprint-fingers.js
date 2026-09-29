(function(){
  const groups = [
    {
      label: 'Mano derecha',
      fingers: [
        { value: 'pulgar_derecho', label: 'Pulgar' },
        { value: 'indice_derecho', label: 'Índice' },
        { value: 'corazon_derecho', label: 'Corazón' },
        { value: 'anular_derecho', label: 'Anular' },
        { value: 'menique_derecho', label: 'Meñique' }
      ]
    },
    {
      label: 'Mano izquierda',
      fingers: [
        { value: 'pulgar_izquierdo', label: 'Pulgar' },
        { value: 'indice_izquierdo', label: 'Índice' },
        { value: 'corazon_izquierdo', label: 'Corazón' },
        { value: 'anular_izquierdo', label: 'Anular' },
        { value: 'menique_izquierdo', label: 'Meñique' }
      ]
    }
  ];

  const allFingers = groups.reduce((all, group) => all.concat(group.fingers), []);

  function escapeHtml(value){
    return String(value || '').replace(/[&<>"']/g, char => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#039;'
    }[char]));
  }

  window.fingerprintFingerLabel = function(value){
    const finger = allFingers.find(item => item.value === value);
    if(!finger) return 'dedo seleccionado';
    const hand = value.endsWith('_derecho') ? 'derecho' : 'izquierdo';
    return `${finger.label} ${hand}`;
  };

  window.fingerprintPickerMarkup = function(pickerId, inputId, selected){
    const hands = groups.map(group => `
      <div class="fingerprint-hand">
        <div class="fingerprint-hand-label">${group.label}</div>
        <div class="fingerprint-finger-grid">
          ${group.fingers.map(finger => `
            <button type="button" class="fingerprint-finger${finger.value === selected ? ' active' : ''}" data-finger-value="${finger.value}">
              ${finger.label}
            </button>
          `).join('')}
        </div>
      </div>
    `).join('');

    return `
      <div class="fingerprint-picker" id="${escapeHtml(pickerId)}" data-input-id="${escapeHtml(inputId)}">
        <div class="fingerprint-picker-title"><i class="bi bi-hand-index-thumb me-1"></i>Seleccione el dedo</div>
        ${hands}
        <div class="fingerprint-selected">Seleccionado: <strong data-selected-label>${escapeHtml(window.fingerprintFingerLabel(selected))}</strong></div>
      </div>
    `;
  };

  window.initFingerprintPicker = function(pickerId, inputId, onChange){
    const picker = document.getElementById(pickerId);
    const input = document.getElementById(inputId);
    if(!picker || !input) return;

    const update = (value, notify = true) => {
      input.value = value;
      picker.querySelectorAll('[data-finger-value]').forEach(button => {
        button.classList.toggle('active', button.dataset.fingerValue === value);
      });
      const label = picker.querySelector('[data-selected-label]');
      if(label) label.textContent = window.fingerprintFingerLabel(value);
      if(notify && typeof onChange === 'function') onChange(value);
    };

    picker.querySelectorAll('[data-finger-value]').forEach(button => {
      button.addEventListener('click', () => update(button.dataset.fingerValue));
    });
    update(input.value || 'indice_derecho', false);
  };
})();
