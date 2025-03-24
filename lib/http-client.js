'use strict';

const axios = require('axios');

class HttpClient {
  constructor(options = {}) {
    this.client = axios.create({
      baseURL: options.baseURL || '',
      timeout: options.timeout || 5000,
      headers: options.headers || {}
    });
  }

  async get(path, params) {
    try {
      const response = await this.client.get(path, { params });
      return response.data;
    } catch (error) {
      throw new Error(`GET request failed: ${error.message}`);
    }
  }

  async post(path, data) {
    try {
      const response = await this.client.post(path, data);
      return response.data;
    } catch (error) {
      throw new Error(`POST request failed: ${error.message}`);
    }
  }

  async put(endpoint, data) {
    try {
      const url = this._buildUrl(endpoint);
      const response = await axios.put(url, data, {
        timeout: this.timeout,
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        }
      });
      return response.data;
    } catch (error) {
      this._handleError(error);
    }
  }

  _buildUrl(endpoint) {
    // Handle both cases where endpoint starts with / or not
    const formattedEndpoint = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
    return `${this.baseUrl}${formattedEndpoint}`;
  }

  _handleError(error) {
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      throw new Error(`Request failed with status ${error.response.status}: ${error.response.data}`);
    } else if (error.request) {
      // The request was made but no response was received
      throw new Error(`No response received: ${error.message}`);
    } else {
      // Something happened in setting up the request that triggered an Error
      throw new Error(`Request error: ${error.message}`);
    }
  }
}

module.exports = {
  HttpClient
}; 