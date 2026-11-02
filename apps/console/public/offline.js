// Shown by the service worker when a page can't load (#2341). The wording
// fits any device: offline, or online but unable to reach this Curia.
var reason = document.getElementById('offline-reason');
var host = location.host;

function describe() {
  if (!reason) return;
  if (navigator.onLine === false) {
    reason.textContent = "This device is offline. Curia will reconnect when you're back online.";
    return;
  }
  reason.textContent = "This device is online, but it can't reach your Curia at " + host
    + ". If Curia is only reachable on a particular network or VPN, connect to that and try again.";
}

describe();
window.addEventListener('offline', describe);
// Back online: try straight away rather than waiting for a tap.
window.addEventListener('online', function () { location.reload(); });

var retry = document.getElementById('offline-retry');
if (retry) retry.addEventListener('click', function () { location.reload(); });
