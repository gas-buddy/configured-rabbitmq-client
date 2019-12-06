configured-rabbitmq-client
==========================
A small wrapper around the rabbot to allow configuration from confit.

## Persistent messages
exchanges and queues are `durable` by default. You can make messages persistent in an exchangeGroup (primary, retry and rejected) by doing the following:
```
{
  "exchangeGroups": {
    "exchange.test.request.v1": {
      "persistent": true,
      "keys": "exchange.test"
    }
  }
} 
```

 Follow [this link](https://github.com/gas-buddy/wiki/wiki/Persistent-rabbitMQ-messages) to see more options

## TTL
Only retry queue use TTL by default. You can set it by doing the following.

NOTE: **You cannot change TTL on an existing queue**.
```
{
  "exchangeGroups": {
    "exchange.test.request.v1": {
      ...
      "perMessageTtl": true, // It should be used on new exchange groups even if you don't change the default value
      "retryDelay": 60000, // default 10000ms
    }
  }
}
```
