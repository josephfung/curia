var host = document.getElementById('offline-host');
if (host) host.textContent = location.host;
var retry = document.getElementById('offline-retry');
if (retry) retry.addEventListener('click', function () { location.reload(); });
