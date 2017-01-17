file="kafka_2.11-0.10.1.0.tgz"
if ! [ -f "$file" ]
then
	wget http://www-eu.apache.org/dist/kafka/0.10.1.0/kafka_2.11-0.10.1.0.tgz
  tar -zxvf kafka_2.11-0.10.1.0.tgz
fi

topicsInKafka=$(./kafka_2.11-0.10.1.0/bin/kafka-topics.sh --list --zookeeper 127.0.0.1:2181)

for topic in "$@"
do
  :
  if echo $topicsInKafka | grep -q $topic
  then
    echo $topic "does exist";
  else
    echo $topic "does not exist, creating it" $topic;
    ./kafka_2.11-0.10.1.0/bin/kafka-topics.sh --create --zookeeper 127.0.0.1:2181 --replication-factor 1 --partitions 1 --topic $topic
  fi
done
