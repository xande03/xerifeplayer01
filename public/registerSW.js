// Registra o service worker da PWA (cache do shell + catálogos para uso offline).
if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then((reg) => {
        // Busca nova versão do SW a cada carga (update cycle padrão)
        reg.update().catch(() => {});
      })
      .catch((err) => console.warn('[PWA] Falha ao registrar service worker:', err));
  });
}
