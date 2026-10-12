const dgram = require('dgram');
const http = require('http');
const { parseStringPromise } = require('xml2js');

class UPnPService {
  constructor(location, usn) {
    this.location = location;
    this.usn = usn;
    this.controlUrl = null;
    this.eventSubUrl = null;
    this.subscriptionId = null;
  }

  async initialize() {
    const serviceDescriptionXml = await this.httpGet(this.location);
    const serviceDescription = await parseStringPromise(serviceDescriptionXml);
    const service = serviceDescription.root.device[0].serviceList[0].service.find(service => 
      service.serviceType[0].includes('RenderingControl'));

    this.controlUrl = service.controlURL[0];
    this.eventSubUrl = service.eventSubURL[0];
  }

  async setVolume(volume) {
    const soapBody = `
      <s:Envelope xmlns:s="[http://schemas.xmlsoap.org/soap/envelope/"](http://schemas.xmlsoap.org/soap/envelope/") s:encodingStyle="[http://schemas.xmlsoap.org/soap/encoding/">](http://schemas.xmlsoap.org/soap/encoding/">)
        <s:Body>
          <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
            <InstanceID>0</InstanceID>
            <Channel>Master</Channel>
            <DesiredVolume>${volume}</DesiredVolume>
          </u:SetVolume>
        </s:Body>
      </s:Envelope>
    `;

    await this.httpPost(`http://${new URL(this.location).hostname}:${new URL(this.location).port}${this.controlUrl}`, soapBody, {
      'Content-Type': 'text/xml; charset="utf-8"',
      'SOAPACTION': '"urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"'
    });
    console.log('Volume set successfully');
  }

  async subscribeToEvents(callbackUrl) {
    const headers = {
      'CALLBACK': `<${callbackUrl}>`,
      'NT': 'upnp:event',
      'TIMEOUT': 'Second-3600'
    };

    const responseHeaders = await this.httpRequest('SUBSCRIBE', `http://${new URL(this.location).hostname}:${new URL(this.location).port}${this.eventSubUrl}`, headers);
    this.subscriptionId = responseHeaders.sid;
    console.log('Subscribed to events with SID:', this.subscriptionId);
  }

  async renewSubscription() {
    if (!this.subscriptionId) {
      throw new Error('No subscription ID to renew');
    }

    const headers = {
      'SID': this.subscriptionId,
      'TIMEOUT': 'Second-3600'
    };

    await this.httpRequest('SUBSCRIBE', `http://${new URL(this.location).hostname}:${new URL(this.location).port}${this.eventSubUrl}`, headers);
    console.log('Subscription renewed with SID:', this.subscriptionId);
  }

  httpGet(url) {
    return new Promise((resolve, reject) => {
      http.get(url, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve(data);
        });
      }).on('error', reject);
    });
  }

  httpPost(url, body, headers) {
    return new Promise((resolve, reject) => {
      const options = {
        method: 'POST',
        headers: headers
      };

      const req = http.request(url, options, (res) => {
        res.on('data', () => {});
        res.on('end', () => {
          resolve();
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  httpRequest(method, url, headers) {
    return new Promise((resolve, reject) => {
      const options = {
        method: method,
        headers: headers
      };

      const req = http.request(url, options, (res) => {
        const responseHeaders = {};
        for (const [key, value] of Object.entries(res.headers)) {
          responseHeaders[key.toLowerCase()] = value;
        }
        res.on('data', () => {});
        res.on('end', () => {
          resolve(responseHeaders);
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}

class UPnPController {
  constructor() {
    this.ssdp = dgram.createSocket('udp4');
    this.services = [];
    this.eventServer = null;
  }

  search() {
    this.ssdp.on('message', async (msg, rinfo) => {
      const headers = this.parseHeaders(msg.toString());
      if (headers.ST && headers.ST.includes('RenderingControl')) {
        const service = new UPnPService(headers.LOCATION, headers.USN);
        await service.initialize();
        this.services.push(service);
        console.log(`Found RenderingControl service at ${headers.LOCATION}`);
      }
    });

    this.ssdp.bind(() => {
      this.ssdp.setBroadcast(true);
      this.ssdp.setMulticastTTL(2);
      this.ssdp.addMembership('239.255.255.250');

      const message = Buffer.from(
        `M-SEARCH * HTTP/1.1\r\n` +
        `HOST: 239.255.255.250:1900\r\n` +
        `MAN: "ssdp:discover"\r\n` +
        `MX: 3\r\n` +
        `ST: urn:schemas-upnp-org:service:RenderingControl:1\r\n` +
        `\r\n`
      );

      this.ssdp.send(message, 0, message.length, 1900, '239.255.255.250');
    });

    setTimeout(() => {
      if (this.services.length > 0) {
        this.subscribeToEvents(this.services[0]);
      } else {
        console.log('No RenderingControl services found.');
      }
    }, 5000);
  }

  subscribeToEvents(service) {
    this.eventServer = http.createServer((req, res) => {
      if (req.method === 'NOTIFY') {
        let body = '';
        req.on('data', chunk => {
          body += chunk.toString();
        });
        req.on('end', () => {
          console.log('Event notification received:', body);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
        });
      }
    });

    this.eventServer.listen(0, async () => {
      const localAddress = this.eventServer.address();
      const callbackUrl = `http://${localAddress.address}:${localAddress.port}`;
      await service.subscribeToEvents(callbackUrl);
    });
  }

  async setVolume(volume) {
    if (this.services.length > 0) {
      await this.services[0].setVolume(volume);
    } else {
      console.log('No RenderingControl services available to set volume.');
    }
  }

  async renewSubscription() {
    if (this.services.length > 0) {
      await this.services[0].renewSubscription();
    } else {
      console.log('No RenderingControl services available to renew subscription.');
    }
  }

  parseHeaders(headerString) {
    const headers = {};
    headerString.split('\r\n').forEach(line => {
      const parts = line.split(': ');
      if (parts.length === 2) {
        headers[parts[0].toUpperCase()] = parts[1];
      }
    });
    return headers;
  }
}

// Usage example
const controller = new UPnPController();
controller.search();

setTimeout(async () => {
  await controller.setVolume(15);
}, 10000);

setTimeout(async () => {
  await controller.renewSubscription();
}, 3600000); // Renew subscription after 1 hour