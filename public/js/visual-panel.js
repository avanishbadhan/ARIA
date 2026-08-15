import { el } from './state.js';

export function closeVisualPanel() {
    el.visualPanel.classList.remove('visible');
    el.visualSubtitle.classList.remove('visible');
    el.reactorWrapper.classList.remove('hidden-mode');
}

function showVisualPanel(contentNode) {
    while (el.visualContent.firstChild) {
        el.visualContent.removeChild(el.visualContent.firstChild);
    }
    el.visualContent.appendChild(contentNode);
    el.reactorWrapper.classList.add('hidden-mode');
    setTimeout(() => {
        el.visualPanel.classList.add('visible');
    }, 150);
}

export function displayDiagram(mermaidCode) {
    const container = document.createElement('div');
    container.className = 'mermaid';
    container.style.width = '100%';
    container.style.textAlign = 'center';
    container.textContent = mermaidCode;
    showVisualPanel(container);
    setTimeout(() => { mermaid.run(); }, 100);
}

export function displayImage(query) {
    const img = document.createElement('img');
    img.alt = query;
    img.src = `https://source.unsplash.com/featured/?${encodeURIComponent(query)}`;
    img.onerror = () => {
        img.onerror = null;
        img.src = 'https://dummyimage.com/600x400/001020/00f0ff&text=Image+Unavailable';
    };
    showVisualPanel(img);
}
