const https = require('https');
const data = JSON.stringify({
  username: "riyansh",
  date: "2026-08-15",
  title: "Maths Competition Prep - 15 August 2026",
  questions: [
    {n:1, text:"Look at this sequence: 2, 6, 18, 54, ___, ___. What are the next two numbers? Write only the 5th number as your answer.", topic:"Logic & Patterns", difficulty:"Medium", answer:"162", solution:"Each number is multiplied by 3 to get the next one. 2x3=6, 6x3=18, 18x3=54, 54x3=162, 162x3=486. The 5th number is 162."},
    {n:2, text:"Riyansh writes all the whole numbers from 1 to 100. How many times does the digit 7 appear in total?", topic:"Number Sense", difficulty:"Hard", answer:"20", solution:"Count 7 in units place: 7,17,27,37,47,57,67,77,87,97 = 10 times. Count 7 in tens place: 70-79 = 10 times. Total = 20."},
    {n:3, text:"A rectangle has a perimeter of 36 cm. Its length is twice its width. What is the area of the rectangle in cm squared?", topic:"Geometry", difficulty:"Hard", answer:"72", solution:"Let width=w, length=2w. Perimeter=2(2w+w)=6w=36, so w=6. Length=12. Area=12x6=72."},
    {n:4, text:"You have 4 different colours of paint: red, blue, green, and yellow. You want to paint 3 fence posts in a row so that no two posts next to each other are the same colour. How many different ways can you do this?", topic:"Combinatorics", difficulty:"Competition-level", answer:"36", solution:"1st post: 4 choices. 2nd post: 3 choices (not same as 1st). 3rd post: 3 choices (not same as 2nd). Total=4x3x3=36."},
    {n:5, text:"Anna and Ben share some stickers. Anna has 3 times as many stickers as Ben. If Anna gives 12 stickers to Ben, they will have the same number. How many stickers does Anna have at the start?", topic:"Logic & Number Sense", difficulty:"Competition-level", answer:"36", solution:"Let Ben=b, Anna=3b. After giving 12: 3b-12=b+12, so 2b=24, b=12. Anna=3x12=36."}
  ]
});

const req = https.request({
  hostname: 'learningportal-production.up.railway.app',
  path: '/api/comp-prep',
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, res => {
  let body = '';
  res.on('data', c => body += c);
  res.on('end', () => console.log(body));
});
req.write(data);
req.end();