window.garyHandler = function(msg) {
  try {
    switch(msg.command) {
      case 'click':
        const el = document.querySelector(msg.selector);
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(() => el.click(), 100);
          return { success: true, text: el.textContent?.slice(0, 100) };
        }
        return { error: 'Element not found', selector: msg.selector };
        
      case 'type':
        const input = document.querySelector(msg.selector);
        if (input) {
          if (msg.clear) input.value = '';
          input.value = msg.text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return { success: true };
        }
        return { error: 'Input not found' };
        
      case 'scroll':
        const amt = msg.amount || 500;
        window.scrollBy(
          msg.direction === 'left' ? -amt : msg.direction === 'right' ? amt : 0,
          msg.direction === 'up' ? -amt : msg.direction === 'down' ? amt : 0
        );
        return { success: true, scrollY: window.scrollY };
        
      case 'get_text':
        const t = document.querySelector(msg.selector);
        return { text: t?.textContent || t?.value || null, found: !!t };
        
      case 'find_element':
        const f = document.querySelector(msg.selector);
        if (f) {
          const rect = f.getBoundingClientRect();
          return { 
            found: true, 
            tag: f.tagName,
            rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
          };
        }
        return { found: false };
        
      case 'screenshot':
        return { success: true, note: 'Screenshot handled by extension API' };
        
      case 'navigate':
        window.location.href = msg.url;
        return { success: true };
        
      case 'execute_js':
        const result = eval(msg.code);
        return { success: true, result: String(result) };
        
      default:
        return { error: 'Unknown command: ' + msg.command };
    }
  } catch(e) {
    return { error: e.message };
  }
};

// Element picker: Shift+Ctrl+hover
document.addEventListener('mouseover', (e) => {
  if (e.shiftKey && e.ctrlKey) {
    const el = e.target;
    const rect = el.getBoundingClientRect();
    el.style.outline = '2px solid #00ff00';
    
    const getSelector = (el) => {
      if (el.id) return '#' + el.id;
      if (el.className) return '.' + el.className.split(' ')[0];
      return el.tagName.toLowerCase();
    };
    
    console.log('[Gary] Element:', getSelector(el), el);
  }
}, true);

document.addEventListener('mouseout', (e) => {
  if (e.shiftKey && e.ctrlKey) {
    e.target.style.outline = '';
  }
}, true);

console.log('[Gary] Browser control loaded');
