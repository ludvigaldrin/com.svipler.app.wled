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

      // Process existing discovery results
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

  // Called when a discovery result is added
  onDiscoveryAvailable(discoveryResult) {
    this.log('Discovery available:', discoveryResult.name);
  }

  // Called when a discovery result address changes
  onDiscoveryAddressChanged(discoveryResult) {
    this.log('Discovery address changed:', discoveryResult.name);
    const id = discoveryResult.id;
    this.discoveryResults[id] = discoveryResult;
  }

  // Called when a discovery result's last seen timestamp changes
  onDiscoveryLastSeenChanged(discoveryResult) {
    this.log('Discovery last seen changed:', discoveryResult.name);
  }
  
  // Helper method to get device info from API
  async getDeviceInfo(ip) {
    try {
      this.log(`Getting device info from IP: ${ip}`);
      
      // Create HTTP client for this IP
      const httpClient = new HttpClient({
        baseURL: `http://${ip}`,
        timeout: 5000
      });
      
      // Get device info from WLED API
      const info = await httpClient.get('/json/info');
      
      // Log the complete response
      this.log('WLED API Response:', JSON.stringify(info, null, 2));
      
      // Extract useful information from the API response
      
      // Use the custom name if it exists, or generate a friendly name based on host/mac
      let deviceName = 'WLED';
      if (info.name && info.name !== 'WLED') {
        // Use custom name if it's been changed from default
        deviceName = info.name;
      } else if (info.host) {
        // Use hostname if available
        deviceName = info.host;
      } else if (info.mac) {
        // Use a friendly name based on MAC address
        const shortMac = info.mac.substring(info.mac.length - 6);
        deviceName = `WLED-${shortMac}`;
      }
      
      // Get MAC address for a reliable ID
      const mac = info.mac ? info.mac.replace(/:/g, '') : '';
      
      // Create a unique ID - use MAC if available, otherwise fallback to IP-based ID
      const deviceId = mac ? `wled-${mac.toLowerCase()}` : `wled-${ip.replace(/\./g, '-')}`;
      
      // Create the device data
      const deviceData = {
        name: deviceName,
        data: {
          id: deviceId
        },
        settings: {
          address: ip,
          pollInterval: 5,
          // Store additional info from the API for reference
          version: info.ver || '',
          fxcount: info.fxcount || 0,
          palcount: info.palcount || 0,
          ledCount: info.leds?.count || 0
        }
      };
      
      this.log(`Generated device data:`, JSON.stringify(deviceData, null, 2));
      
      return deviceData;
    } catch (error) {
      this.error(`Error getting device info: ${error.message}`);
      throw new Error(`Could not connect to WLED device: ${error.message}`);
    }
  }

  async onPair(session) {
    this.log('************ STARTING PAIRING PROCESS ************');
    this.log('Driver version: 1.0.4 with Homey logging');

    // Track active view to prevent cross-view device creation
    let activeView = '';
    let manualDevice = null;
    let discoveryDevices = [];

    // Debug: Print all discoveryResults
    this.log('Current discovery results:', JSON.stringify(Object.values(this.discoveryResults || {}), null, 2));
    
    // Add a logging endpoint for HTML pages
    session.setHandler('log', async (message) => {
      this.log('TEMPLATE LOG:', message);
      return true;
    });

    // Handle view navigation - CRITICAL for cleaning up state between views
    session.setHandler('showView', async (view) => {
      this.log(`NAVIGATION - Changed view from ${activeView} to ${view}`);
      activeView = view;
      
      // Clear appropriate selections when switching views
      if (view === 'manual_entry') {
        this.log('NAVIGATION - Switched to manual entry, clearing discovery devices');
        // Clear discovery devices when going to manual entry
        discoveryDevices = [];
      } else if (view === 'list_devices') {
        this.log('NAVIGATION - Switched to discovery, clearing manual device');
        // Clear manual device when going to discovery
        manualDevice = null;
      }
    });

    // Handle device creation - CENTRAL POINT for all device creation
    session.setHandler('createDevice', async (device) => {
      try {
        this.log('CREATE DEVICE CALLED with data:', JSON.stringify(device, null, 2));
        this.log(`CREATE DEVICE - Current view: ${activeView}`);
        
        // Return ONLY the device that was directly created by the current view
        if (activeView === 'manual_entry') {
          if (!manualDevice) {
            this.log('CREATE DEVICE ERROR - No manual device available');
            throw new Error('No manual device available');
          }
          
          // ONLY return the manual device, ignore any other device data
          this.log('CREATE DEVICE - Creating ONLY the manual device:', JSON.stringify(manualDevice, null, 2));
          return manualDevice;
        } 
        else if (activeView === 'list_devices' || activeView === 'add_device_finish') {
          // For discovery, ONLY return the device that was selected
          if (!device || !device.data || !device.data.id) {
            this.log('CREATE DEVICE ERROR - Invalid device data');
            throw new Error('Invalid device data');
          }
          
          const matchingDevice = discoveryDevices.find(d => d.data.id === device.data.id);
          if (!matchingDevice) {
            this.log('CREATE DEVICE ERROR - Device not found in discovery list');
            throw new Error('Device not found in discovery list');
          }
          
          // Return ONLY this single device
          this.log('CREATE DEVICE - Creating ONLY the selected discovery device:', 
                     JSON.stringify(matchingDevice, null, 2));
          return matchingDevice;
        }
        
        this.log('CREATE DEVICE ERROR - Unknown view context:', activeView);
        throw new Error(`Unknown view context: ${activeView}`);
      } catch (error) {
        this.error('Error in createDevice:', error);
        throw error;
      }
    });

    // Handle manual IP entry
    session.setHandler('manual_entry', async (data) => {
      try {
        const ip = data.ip;
        this.log(`========== MANUAL - Testing connection to IP: ${ip} ==========`);
        
        // Use our common method to get device info
        const deviceInfo = await this.getDeviceInfo(ip);
        
        // Save this as the current manual device
        manualDevice = deviceInfo;
        
        // Add extra debugging
        this.log(`MANUAL - DEVICE STRUCTURE:
Device Name: ${deviceInfo.name}
Device ID: ${deviceInfo.data.id}
Settings: ${JSON.stringify(deviceInfo.settings, null, 2)}
Full Object: ${JSON.stringify(deviceInfo, null, 2)}`);

        return deviceInfo;
      } catch (error) {
        this.error(`MANUAL - Connection test failed: ${error.message}`);
        return Promise.reject(new Error(`Could not connect to WLED device: ${error.message}`));
      }
    });

    // Handle list_devices view (discovery)
    session.setHandler('list_devices', async () => {
      this.log('========== DISCOVERY - Getting discovered devices ==========');
      const devices = [];

      // Add discovered devices from mDNS
      const discoveryResults = Object.values(this.discoveryResults || {});
      this.log(`DISCOVERY - Found ${discoveryResults.length} devices via discovery`);

      // Process each discovered device
      for (const discoveryResult of discoveryResults) {
        if (discoveryResult && discoveryResult.address) {
          try {
            // Get detailed device info from the API
            this.log(`DISCOVERY - Getting info for ${discoveryResult.address}`);
            const deviceInfo = await this.getDeviceInfo(discoveryResult.address);
            
            // Add extra debugging
            this.log(`DISCOVERY - DEVICE STRUCTURE for ${discoveryResult.address}:
Device Name: ${deviceInfo.name}
Device ID: ${deviceInfo.data.id}
Settings: ${JSON.stringify(deviceInfo.settings, null, 2)}
Full Object: ${JSON.stringify(deviceInfo, null, 2)}`);
            
            devices.push(deviceInfo);
          } catch (error) {
            // Log the error but continue with other devices
            this.error(`DISCOVERY - Error getting info for discovered device at ${discoveryResult.address}: ${error.message}`);
            
            // Fall back to basic info
            const device = {
              name: discoveryResult.name || `WLED (${discoveryResult.address})`,
              data: {
                id: `wled-${discoveryResult.address.replace(/\./g, '-')}`
              },
              settings: {
                address: discoveryResult.address,
                pollInterval: 5
              }
            };
            this.log(`DISCOVERY - Using fallback info for ${discoveryResult.address}:`, JSON.stringify(device, null, 2));
            devices.push(device);
          }
        }
      }

      // Save the discovery devices for later reference
      discoveryDevices = [...devices];
      
      this.log(`DISCOVERY - Returning ${devices.length} devices:`, JSON.stringify(devices, null, 2));
      return devices;
    });

    // Handle device selection
    session.setHandler('list_device_selection', async (device) => {
      this.log('SELECTION - Device selected:', JSON.stringify(device, null, 2));
      return device;
    });
  }
}

module.exports = WLEDDriver;