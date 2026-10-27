# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). Its
register map was read in the manufacturer's manual and checked against the
project below, from which the following facts were taken (rewritten in
JavaScript, no code copied): the sentinel values 0x8000 and -3000, the "-1 =
no request" value of the heating circuit mode, the module numbering, the
scales of the heat pump registers, and the single lock around every Modbus
request.

## lambda_heat_pumps

<https://github.com/GuidoJeuken-6512/lambda_heat_pumps>, the Home Assistant
(HACS) integration for Lambda heat pumps, by GuidoJeuken-6512 and
contributors, version V2.8.6 (tag `V2.8.6`, commit d00dde4, 2026-09-05). MIT
License (`LICENSE` of the repository). Its notice, as published (the
copyright line of its template was never filled in):

````
MIT License

Copyright (c) 2024 Your Name

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Lambda Modbus protocol

"Modbus-Protokoll 1.0" (LAMBDA Wärmepumpen GmbH, 2026): the register numbers,
formats, units and code meanings of `src/lambda.js` and `src/i18n.js` come
from this manual. No text of it is reproduced; the names of the codes are our
own translations.
````
