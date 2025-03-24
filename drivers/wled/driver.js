'use strict';

const Homey = require('homey');
const { HttpClient } = require('../../lib/http-client');

class WLEDDriver extends Homey.Driver {

  async onInit() {
    this.log('WLED Driver initialized');

    // Initialize discovery results storage
    this.discoveryResults = {};

    // Get the discovery strategy
    try {
      this.discoveryStrategy = this.getDiscoveryStrategy();

      // Listen for new discovery results
      this.discoveryStrategy.on('result', this.onDiscoveryResult.bind(this));

      // Process existing discovery results (correctly iterate over object)
      const currentResults = this.discoveryStrategy.getDiscoveryResults();
      this.log('Initial discovery results:', Object.keys(currentResults).length);
      for (const discoveryResult of Object.values(currentResults)) {
        this.onDiscoveryResult(discoveryResult);
      }
    } catch (error) {
      this.error('Discovery strategy error:', error);
    }

    this.homey.on('unload', () => {
      this.log('App is unloading, cleaning up discovery listeners');
    });
  }

  // Handle device discovery
  onDiscoveryResult(discoveryResult) {
    this.log('Discovery result', discoveryResult.name + ' ' + discoveryResult.address);

    // Store results for pairing
    this.discoveryResults[discoveryResult.id] = discoveryResult;
  }

  // This method is called when a discovery result is added
  onDiscoveryAvailable(discoveryResult) {
    this.log('Discovery available:', discoveryResult);
    // We already store it in onDiscoveryResult
  }

  // This method is called when a discovery result address changes
  onDiscoveryAddressChanged(discoveryResult) {
    this.log('Discovery address changed:', discoveryResult);
    // Update our stored entry
    const id = discoveryResult.id;
    this.discoveryResults[id] = discoveryResult;
  }

  // This method is called when a discovery result's last seen timestamp changes
  onDiscoveryLastSeenChanged(discoveryResult) {
    // Just log it, no action needed
    this.log('Discovery last seen changed:', discoveryResult);
  }

  async onPair(session) {
    this.log('Starting pairing process');

    // Store the manual device for pairing
    this.manualDevice = null;

    // When a view is shown
    session.setHandler('showView', async (view) => {
      this.log(`Showing view: ${view}`);
      
      if (view === 'add_device_finish') {
        this.log('Device pairing process completing...');
      }
    });

    // Handle manual IP entry view
    session.setHandler('manual_entry', async (data) => {
      try {
        const ip = data.ip;
        this.log(`Attempting manual entry with IP: ${ip}`);

        // Create HTTP client for this IP
        const httpClient = new HttpClient({
          baseURL: `http://${ip}`,
          timeout: 5000
        });

        this.log('Created HTTP client, fetching device info...');

        // Check if this is a WLED device
        const info = await httpClient.get('/json/info');
        const name = info.name || 'WLED';

        this.log(`Got device info: ${name}`);

        // Create device object for immediate creation
        const deviceId = `wled-manual-${ip.replace(/\./g, '-')}`;
        const device = {
          name: name,
          data: {
            id: deviceId
          },
          settings: {
            address: ip,
            pollInterval: 5
          }
        };

        // Store the manual device for the add_device handler
        this.manualDevice = device;
        this.log(`Manual device prepared for pairing:`, this.manualDevice);

        return device;
      } catch (error) {
        this.error(`Error during manual entry: ${error.message}`);
        return Promise.reject(new Error(`Could not connect to WLED device: ${error.message}`));
      }
    });

    // Handle list_devices view (discovery)
    session.setHandler('list_devices', async () => {
      this.log('Handler: list_devices called');

      const devices = [];

      // Log what we have in discoveryResults
      this.log('Current discovery results:', Object.keys(this.discoveryResults));

      // Add discovered devices from mDNS
      const discoveryResults = Object.values(this.discoveryResults || {});
      this.log(`Found ${discoveryResults.length} devices via discovery`);

      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          const device = {
            name: discoveryResult.name || `WLED (${discoveryResult.address})`,
            data: {
              id: `wled-${discoveryResult.address.replace(/\./g, '-')}`
            },
            settings: {
              address: discoveryResult.address,
              pollInterval: 5
            },
            capabilities: [
              {
                "id": "wled_effect",
                "value": "0"
              },
              {
                "id": "wled_palette",
                "value": "0"
              }
            ]
          };

          devices.push(device);
        }
      }

      return devices;
    });

    // Handle device selection from list_devices
    session.setHandler('list_device_selection', async (device) => {
      this.log('Device selected:', device);
      return device;
    });

    // Handle device being added - this is called when the add button is pressed in manual entry
    session.setHandler('add_device', async (device) => {
      this.log('Adding device to Homey via add_device:', device);
      return device; // This will be passed to the add_devices template
    });
    
    // Handle multiple devices being added - standard handler for add_devices template
    session.setHandler('add_devices', async (devices) => {
      this.log(`Adding ${devices ? devices.length : 0} device(s) to Homey via add_devices:`, devices);
      return devices;
    });
  }
}

module.exports = WLEDDriver;