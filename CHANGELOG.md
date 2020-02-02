7.0.0
=====
* Set `replyQueue` to false by default, avoiding an unused queue
* If a subscription goes against a missing queue, try with '.q' appended in case the caller used an exchange name instead of a queue name
* Assert when subscribing to a non-existent queue, so we get a better error message

9.0.0
=====
* Switch to foo-foo-mq which is just rabbot with updated deps
