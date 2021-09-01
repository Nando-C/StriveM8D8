# StriveM8D8

Now that you have seen how to have sockets join rooms from the backend, implement a 1 to 1 chat, considering that socket.io is conveniently having each socket join automatically a room which has the same name of that socket id. 

For example: a socket with id abc123 is always in a room with the name `abc123`.

Polish up the frontend implementing different "chat windows": you already have a sidebar with available users; on click on any of these, you will set the "current chat user" with the selected socket id and retrieve the previous messages with that socket id.
