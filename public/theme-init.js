// Applied synchronously (before paint) to avoid a flash of the wrong theme.
(function () {
  var t = localStorage.getItem('leadflow-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
})();
